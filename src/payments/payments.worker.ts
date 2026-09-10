import { Injectable, Logger } from '@nestjs/common';
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { processPaymentMessageSchema } from './dto/process-payment.message';
import { PaymentsProcessor } from './payments.processor';

@Injectable()
export class PaymentsWorker { 
    private readonly logger = new Logger(PaymentsWorker.name);

    constructor(private readonly processor: PaymentsProcessor) {}

    async handle(event: SQSEvent): Promise<SQSBatchResponse> {
        const batchItemFailures: SQSBatchItemFailure[] = [];

        for (const record of event.Records) { 
            try { 
                await this.processor.run(this.parse(record));
            } catch (error) { 
                this.logger.error(
                    `message ${record.messageId} failed on receive ` + 
                    `${record.attributes.ApproximateReceiveCount} : ${error}`,
                );
                batchItemFailures.push({ itemIdentifier: record.messageId });
            }
        }

        return { batchItemFailures}
    }

    private parse(record: SQSRecord) { 
        return processPaymentMessageSchema.parse(JSON.parse(record.body))
    }
}