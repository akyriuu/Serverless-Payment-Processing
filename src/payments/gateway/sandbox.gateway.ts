import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { 
    ChargeCommand,
    ChargeResult,
    PaymentGateway,
} from './payment.gateway';
import { PermanentGatewayError, RetryableGatewayError } from './gateway.errors';

@Injectable()
export class SandboxGateway extends PaymentGateway { 
    async charge(command: ChargeCommand): Promise<ChargeResult> { 
        if (command.amountCents > 1_000_000) { 
            throw new PermanentGatewayError('amount_too_large', 'Amount above the limit');
        }

        const roll = Math.random();

        if (roll < 0.15) { 
            throw new RetryableGatewayError('gateway_timeout', 'Provider timeout');
        }

        if (roll < 0.2) { 
            throw new PermanentGatewayError('card_declined', 'Card was declined');
        }

        return { providerRef: `ch_${randomUUID()}`, authorizedAt: new Date() }
    }
}
