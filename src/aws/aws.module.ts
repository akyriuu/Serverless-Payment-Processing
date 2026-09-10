import { Module } from '@nestjs/common';
import { PaymentEventsPublisher } from './payment-events.publisher';
import { PaymentsQueue } from './payments.queue';
import { ReceiptsStorage } from './receipts.storage';

@Module({
    providers: [PaymentsQueue, ReceiptsStorage, PaymentEventsPublisher],
    exports: [PaymentsQueue, ReceiptsStorage, PaymentEventsPublisher],
})

export class AwsModule {}