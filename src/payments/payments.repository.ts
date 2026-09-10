import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Payment, PaymentStatus, Prisma } from '../generated/prisma/client';
import type { StoredReceipt } from '../aws/receipts.storage';
import type { CreatePaymentCommand } from './dto/create-payment.dto';
import type { FindPaymentsDto } from './dto/find-payments.dto';

type AttemptRecord = {
  number: number;
  status: PaymentStatus;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
};

export type PaymentTransition = {
  payment: Payment;
  eventId: string;
};

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(command: CreatePaymentCommand): Promise<Payment> {
    return this.prisma.payment.create({ data: command });
  }

  find(id: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { idempotencyKey } });
  }

  list(query: FindPaymentsDto): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: { customerId: query.customerId, status: query.status },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
  }

  // Só um consumidor sai daqui com o pagamento: o updateMany filtra por status,
  // então uma redelivery concorrente devolve count 0.
  async claim(id: string): Promise<Payment | null> {
    const { count } = await this.prisma.payment.updateMany({
      where: { id, status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } },
      data: { status: PaymentStatus.PROCESSING, attemptCount: { increment: 1 } },
    });

    return count === 0 ? null : this.find(id);
  }

  settle(input: {
    payment: Payment;
    providerRef: string;
    attempt: AttemptRecord;
  }): Promise<PaymentTransition> {
    const { payment, providerRef, attempt } = input;

    return this.prisma.$transaction(async (tx) => {
      const settled = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.SUCCEEDED,
          providerRef,
          settledAt: new Date(),
          failureCode: null,
          failureMessage: null,
        },
      });

      await tx.paymentAttempt.create({ data: { paymentId: payment.id, ...attempt } });

      const event = await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          type: 'payment.succeeded',
          payload: { providerRef } as Prisma.JsonObject,
        },
        select: { id: true },
      });

      return { payment: settled, eventId: event.id };
    });
  }

  reject(input: { payment: Payment; attempt: AttemptRecord }): Promise<PaymentTransition> {
    const { payment, attempt } = input;

    return this.prisma.$transaction(async (tx) => {
      const rejected = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          failureCode: attempt.errorCode,
          failureMessage: attempt.errorMessage,
          settledAt: new Date(),
        },
      });

      await tx.paymentAttempt.create({ data: { paymentId: payment.id, ...attempt } });

      const event = await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          type: 'payment.failed',
          payload: {
            code: attempt.errorCode,
            message: attempt.errorMessage,
          } as Prisma.JsonObject,
        },
        select: { id: true },
      });

      return { payment: rejected, eventId: event.id };
    });
  }

  // Devolve o pagamento pra fila lógica antes de deixar o SQS redeliver.
  async release(input: { payment: Payment; attempt: AttemptRecord }): Promise<void> {
    const { payment, attempt } = input;

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PENDING,
          failureCode: attempt.errorCode,
          failureMessage: attempt.errorMessage,
        },
      }),

      this.prisma.paymentAttempt.create({ data: { paymentId: payment.id, ...attempt } }),
    ]);
  }

  async markEventPublished(id: string): Promise<void> {
    await this.prisma.paymentEvent.update({
      where: { id },
      data: { publishedAt: new Date() },
    });
  }

  async attachReceipt(input: { paymentId: string; receipt: StoredReceipt }): Promise<void> {
    const { paymentId, receipt } = input;

    await this.prisma.receipt.upsert({
      where: { paymentId },
      create: { paymentId, ...receipt },
      update: receipt,
    });
  }
}