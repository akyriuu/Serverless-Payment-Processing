import { IsEnum, IsIn, IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator' 
import { PaymentMethod } from '../../generated/prisma/client'

export class CreatePaymentDto { 
    @IsString()
    @IsNotEmpty()
    @MaxLength(64)
    customerId: string;

    @IsInt()
    @Min(100)
    @Max(10_000_000)
    amountCents: number;

    @IsIn(['BRL', 'USD'])
    currency: string;

    @IsEnum(PaymentMethod)
    method: PaymentMethod;
}

export type CreatePaymentCommand = CreatePaymentDto & { idempotencyKey: string };