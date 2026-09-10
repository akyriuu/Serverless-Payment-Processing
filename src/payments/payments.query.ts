import { Injectable, NotFoundException } from '@nestjs/common';
import type { Payment } from '../generated/prisma/client';
import type { FindPaymentsDto } from './dto/find-payments.dto';
import { PaymentsRepository } from './payments.repository';

@Injectable()
export class PaymentsQuery { 
    constructor(private readonly repository: PaymentsRepository) {}

    async get(id: string): Promise<Payment> { 
        const payment = await this.repository.find(id);
        if (!payment) throw new NotFoundException(`Payment ${id} not found`);
        return payment;
    }

    list(query: FindPaymentsDto): Promise<Payment[]> { 
        return this.repository.list(query);
    }
}