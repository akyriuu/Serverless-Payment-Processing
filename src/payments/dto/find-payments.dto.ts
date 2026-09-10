import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PaymentStatus } from '../../generated/prisma/client';

export class FindPaymentsDto { 
    @IsOptional()
    @IsString()
    customerId?: string;

    @IsOptional()
    @IsEnum(PaymentStatus)
    status?: PaymentStatus;

    @IsOptional()
    @IsString()
    cursor?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit = 20;
}