import { Injectable, Logger } from '@nestjs/common';
import { PaymentEventsPublisher } from '../aws/payment-events.publisher';
import { ReceiptsStorage } from '../aws/receipts.storage';
import { getEnv } from '../config/env';
import { Payment, PaymentStatus } from '../generated/prisma/client';
import type { ProcessPaymentMessage } from './dto/process-payment.message';
import { PermanentGatewayError, RetryableGatewayError } from './gateway/gateway.errors';
import { ChargeResult, PaymentGateway } from './gateway/payment.gateway';
import { PaymentsRepository } from './payments.repository';

@Injectable()
export class PaymentsProcessor {
  private readonly logger = new Logger(PaymentsProcessor.name);
  private readonly maxAttempts = getEnv().MAX_ATTEMPTS;

  constructor(
    private readonly repository: PaymentsRepository,
    private readonly gateway: PaymentGateway,
    private readonly receipts: ReceiptsStorage,
    private readonly events: PaymentEventsPublisher,
  ) {}

  async run(message: ProcessPaymentMessage): Promise<void> {
    const payment = await this.repository.find(message.paymentId);

    if (!payment) {
      this.logger.warn(`payment ${message.paymentId} not found, dropping message`);
      return;
    }

    if (this.isSettled(payment)) {
      this.logger.log(`payment ${payment.id} already ${payment.status}, skipping`);
      return;
    }

    const claimed = await this.repository.claim(payment.id);
    if (!claimed) return;

    const startedAt = Date.now();
    const charge = await this.authorize(claimed, startedAt);
    if (!charge) return;

    // Autorizado no provider. A partir daqui nada marca FAILED.
    const { eventId } = await this.repository.settle({
      payment: claimed,
      providerRef: charge.providerRef,
      attempt: {
        number: claimed.attemptCount,
        status: PaymentStatus.SUCCEEDED,
        latencyMs: Date.now() - startedAt,
      },
    });

    await this.notify({
      payment: claimed,
      eventId,
      type: 'payment.succeeded',
      status: PaymentStatus.SUCCEEDED,
    });

    await this.storeReceipt(claimed, charge);
  }

  private async authorize(payment: Payment, startedAt: number): Promise<ChargeResult | null> {
    if (payment.attemptCount > this.maxAttempts) {
      throw new Error(
        `payment ${payment.id} exceeded ${this.maxAttempts} attempts, awaiting manual review`,
      );
    }

    try {
      return await this.gateway.charge({
        idempotencyKey: payment.idempotencyKey,
        customerId: payment.customerId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        method: payment.method,
      });
    } catch (error) {
      await this.handleFailure({ payment, error, startedAt });
      return null;
    }
  }

  private async handleFailure(input: {
    payment: Payment;
    error: unknown;
    startedAt: number;
  }): Promise<void> {
    const { payment, error, startedAt } = input;

    const attempt = {
      number: payment.attemptCount,
      status: PaymentStatus.FAILED,
      latencyMs: Date.now() - startedAt,
      errorCode: this.codeOf(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    };

    // Recusa explícita do provider é o único caso em que sabemos que não houve
    // cobrança, e portanto o único que autoriza marcar FAILED.
    if (error instanceof PermanentGatewayError) {
      const { eventId } = await this.repository.reject({ payment, attempt });

      await this.notify({
        payment,
        eventId,
        type: 'payment.failed',
        status: PaymentStatus.FAILED,
      });

      this.logger.error(`payment ${payment.id} declined: ${attempt.errorCode}`);
      return;
    }

    await this.repository.release({ payment, attempt });

    // Rethrow devolve a mensagem pro SQS: redelivery agora, DLQ depois de
    // esgotar o maxReceiveCount.
    throw error;
  }

  private async storeReceipt(payment: Payment, charge: ChargeResult): Promise<void> {
    try {
      const receipt = await this.receipts.save(payment, charge);
      await this.repository.attachReceipt({ paymentId: payment.id, receipt });
    } catch (error) {
      this.logger.warn(`failed to store receipt for ${payment.id}: ${error}`);
    }
  }

  private async notify(input: {
    payment: Payment;
    eventId: string;
    type: 'payment.succeeded' | 'payment.failed';
    status: PaymentStatus;
  }): Promise<void> {
    const { payment, eventId, type, status } = input;

    try {
      await this.events.publish({
        type,
        paymentId: payment.id,
        customerId: payment.customerId,
        status,
        occurredAt: new Date().toISOString(),
      });

      await this.repository.markEventPublished(eventId);
    } catch (error) {
      // Estado já commitado; o evento fica no outbox para o sweeper.
      this.logger.warn(`failed to publish ${type} for ${payment.id}: ${error}`);
    }
  }

  private codeOf(error: unknown): string {
    if (error instanceof PermanentGatewayError || error instanceof RetryableGatewayError) {
      return error.code;
    }

    return 'unexpected_error';
  }

  private isSettled(payment: Payment): boolean {
    return payment.status === PaymentStatus.SUCCEEDED || payment.status === PaymentStatus.FAILED;
  }
}