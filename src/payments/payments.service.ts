import { Injectable, Logger } from '@nestjs/common';
import { PaymentsQueue } from '../aws/payments.queue';
import { Payment, Prisma } from '../generated/prisma/client';
import type { CreatePaymentCommand } from './dto/create-payment.dto';
import { PaymentsRepository } from './payments.repository';

@Injectable()
export class PaymentsService { 
    private readonly logger = new Logger(PaymentsService.name);

    constructor(
        private readonly repository: PaymentsRepository,
        private readonly queue: PaymentsQueue,
    ) {}

    async create(command: CreatePaymentCommand): Promise<Payment> {
        const existing = await this.repository.findByIdempotencyKey(command.idempotencyKey);
        if (existing) return existing;

        const payment = await this.persist(command);

        await this.queue.publish({
            paymentId: payment.id,
            idempotencyKey: payment.idempotencyKey,
        });

        return payment;
    }

    

    private async persist(command: CreatePaymentCommand): Promise<Payment> { 
        try { 
            return await this.repository.create(command);
        } catch (error) { 
            // duas requisições concorrentes colidem (por terem a mesma idempotencykey )
            if ( error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                const winner = await this.repository.findByIdempotencyKey(command.idempotencyKey);
                if (winner) return winner;
            }

            throw error;
        }
    }
}