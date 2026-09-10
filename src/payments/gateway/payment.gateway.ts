import type { PaymentMethod } from '../../generated/prisma/client'

export type ChargeCommand = { 
    idempotencyKey: string;
    customerId: string;
    amountCents: number;
    currency: string;
    method: PaymentMethod;  
};

export type ChargeResult = { 
    providerRef: string;
    authorizedAt: Date;
};

export abstract class PaymentGateway { 
    abstract charge(command: ChargeCommand): Promise<ChargeResult>;
}