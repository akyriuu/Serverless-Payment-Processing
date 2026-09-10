import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PaymentEventsPublisher } from '../aws/payment-events.publisher';
import { ReceiptsStorage } from '../aws/receipts.storage';
import { Payment, PaymentMethod, PaymentStatus } from '../generated/prisma/client';
import { PermanentGatewayError, RetryableGatewayError } from './gateway/gateway.errors';
import { PaymentGateway } from './gateway/payment.gateway';
import { PaymentsProcessor } from './payments.processor';
import { PaymentsRepository } from './payments.repository';

jest.mock('../config/env', () => ({
  getEnv: () => ({ MAX_ATTEMPTS: 3 }),
}));

const repository = {
  find: jest.fn(),
  claim: jest.fn(),
  settle: jest.fn(),
  reject: jest.fn(),
  release: jest.fn(),
  attachReceipt: jest.fn(),
  markEventPublished: jest.fn(),
};

const gateway = { charge: jest.fn() };
const receipts = { save: jest.fn() };
const events = { publish: jest.fn() };

const message = { paymentId: 'pay_1', idempotencyKey: 'key_1' };

describe('PaymentsProcessor', () => {
  let processor: PaymentsProcessor;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(async () => {
    jest.resetAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsProcessor,
        { provide: PaymentsRepository, useValue: repository },
        { provide: PaymentGateway, useValue: gateway },
        { provide: ReceiptsStorage, useValue: receipts },
        { provide: PaymentEventsPublisher, useValue: events },
      ],
    }).compile();

    processor = moduleRef.get(PaymentsProcessor);
  });

  describe('when the charge is authorized', () => {
    it('settles the payment with the provider reference', async () => {
      const claimed = arrangeAuthorized();

      await processor.run(message);

      expect(repository.settle).toHaveBeenCalledWith({
        payment: claimed,
        providerRef: 'ch_1',
        attempt: {
          number: 1,
          status: PaymentStatus.SUCCEEDED,
          latencyMs: expect.any(Number),
        },
      });

      expect(repository.reject).not.toHaveBeenCalled();
      expect(repository.release).not.toHaveBeenCalled();
    });

    it('publishes the event and closes the outbox entry', async () => {
      arrangeAuthorized();

      await processor.run(message);

      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'payment.succeeded',
          paymentId: 'pay_1',
          status: PaymentStatus.SUCCEEDED,
        }),
      );

      expect(repository.markEventPublished).toHaveBeenCalledWith('evt_settle');
    });

    it('stores the receipt', async () => {
      arrangeAuthorized();

      await processor.run(message);

      expect(repository.attachReceipt).toHaveBeenCalledWith({
        paymentId: 'pay_1',
        receipt: { bucket: 'receipts', objectKey: 'k.json', checksum: 'abc', bytes: 128 },
      });
    });
  });

  describe('when something fails after the charge was authorized', () => {
    it('keeps the payment settled if the receipt upload fails', async () => {
      arrangeAuthorized();
      receipts.save.mockRejectedValue(new Error('NoSuchBucket'));

      await expect(processor.run(message)).resolves.toBeUndefined();

      expect(repository.settle).toHaveBeenCalled();
      expect(repository.reject).not.toHaveBeenCalled();
      expect(repository.release).not.toHaveBeenCalled();
      expect(repository.attachReceipt).not.toHaveBeenCalled();
    });

    it('leaves the event unpublished if the broker is down', async () => {
      arrangeAuthorized();
      events.publish.mockRejectedValue(new Error('SNS unavailable'));

      await expect(processor.run(message)).resolves.toBeUndefined();

      expect(repository.settle).toHaveBeenCalled();
      expect(repository.markEventPublished).not.toHaveBeenCalled();
      expect(repository.reject).not.toHaveBeenCalled();
    });
  });

  describe('when the provider declines', () => {
    it('marks the payment as failed without retrying', async () => {
      arrangeAuthorized();
      gateway.charge.mockRejectedValue(
        new PermanentGatewayError('card_declined', 'Card was declined'),
      );

      await expect(processor.run(message)).resolves.toBeUndefined();

      expect(repository.reject).toHaveBeenCalledWith({
        payment: expect.objectContaining({ id: 'pay_1' }),
        attempt: expect.objectContaining({
          status: PaymentStatus.FAILED,
          errorCode: 'card_declined',
        }),
      });

      expect(repository.release).not.toHaveBeenCalled();
      expect(repository.settle).not.toHaveBeenCalled();
      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payment.failed' }),
      );
    });
  });

  describe('when the outcome is unknown', () => {
    it('releases and rethrows on a retryable error', async () => {
      arrangeAuthorized();
      const error = new RetryableGatewayError('gateway_timeout', 'Provider timeout');
      gateway.charge.mockRejectedValue(error);

      await expect(processor.run(message)).rejects.toThrow(error);

      expect(repository.release).toHaveBeenCalledWith({
        payment: expect.objectContaining({ id: 'pay_1' }),
        attempt: expect.objectContaining({ errorCode: 'gateway_timeout' }),
      });

      expect(repository.reject).not.toHaveBeenCalled();
      expect(repository.settle).not.toHaveBeenCalled();
    });

    it('never marks the payment as failed on an unexpected error', async () => {
      arrangeAuthorized();
      gateway.charge.mockRejectedValue(new Error('socket hang up'));

      await expect(processor.run(message)).rejects.toThrow('socket hang up');

      expect(repository.release).toHaveBeenCalledWith({
        payment: expect.objectContaining({ id: 'pay_1' }),
        attempt: expect.objectContaining({ errorCode: 'unexpected_error' }),
      });

      expect(repository.reject).not.toHaveBeenCalled();
    });

    it('stops calling the provider once the attempt ceiling is crossed', async () => {
      const payment = buildPayment();
      repository.find.mockResolvedValue(payment);
      repository.claim.mockResolvedValue({ ...payment, attemptCount: 4 });

      await expect(processor.run(message)).rejects.toThrow(/exceeded 3 attempts/);

      expect(gateway.charge).not.toHaveBeenCalled();
      expect(repository.release).not.toHaveBeenCalled();
    });
  });

  describe('when the message is redundant', () => {
    it('drops the message if the payment no longer exists', async () => {
      repository.find.mockResolvedValue(null);

      await processor.run(message);

      expect(repository.claim).not.toHaveBeenCalled();
    });

    it('skips a payment that already reached a terminal state', async () => {
      repository.find.mockResolvedValue(buildPayment({ status: PaymentStatus.SUCCEEDED }));

      await processor.run(message);

      expect(repository.claim).not.toHaveBeenCalled();
      expect(gateway.charge).not.toHaveBeenCalled();
    });

    it('backs off when another consumer already claimed the payment', async () => {
      repository.find.mockResolvedValue(buildPayment());
      repository.claim.mockResolvedValue(null);

      await processor.run(message);

      expect(gateway.charge).not.toHaveBeenCalled();
    });
  });
});

function buildPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1',
    idempotencyKey: 'key_1',
    customerId: 'cus_1',
    amountCents: 25_000,
    currency: 'BRL',
    method: PaymentMethod.PIX,
    status: PaymentStatus.PENDING,
    providerRef: null,
    failureCode: null,
    failureMessage: null,
    attemptCount: 0,
    settledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function arrangeAuthorized(): Payment {
  const payment = buildPayment();
  const claimed = buildPayment({ status: PaymentStatus.PROCESSING, attemptCount: 1 });

  repository.find.mockResolvedValue(payment);
  repository.claim.mockResolvedValue(claimed);
  repository.settle.mockResolvedValue({ payment: claimed, eventId: 'evt_settle' });
  repository.reject.mockResolvedValue({ payment: claimed, eventId: 'evt_reject' });
  repository.release.mockResolvedValue(undefined);
  repository.markEventPublished.mockResolvedValue(undefined);
  repository.attachReceipt.mockResolvedValue(undefined);

  gateway.charge.mockResolvedValue({ providerRef: 'ch_1', authorizedAt: new Date() });
  events.publish.mockResolvedValue(undefined);
  receipts.save.mockResolvedValue({
    bucket: 'receipts',
    objectKey: 'k.json',
    checksum: 'abc',
    bytes: 128,
  });

  return claimed;
}