import { Injectable } from '@nestjs/common';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getEnv } from '../config/env';
import type { ProcessPaymentMessage } from '../payments/dto/process-payment.message';

@Injectable()
export class PaymentsQueue { 
    private readonly client = new SQSClient({
        region: getEnv().AWS_REGION,
        endpoint: getEnv().AWS_ENDPOINT_URL,
    })
    private readonly queueUrl = getEnv().PAYMENTS_QUEUE_URL;
    

    async publish(message: ProcessPaymentMessage): Promise<void> { 
        await this.client.send(
            new SendMessageCommand({
                QueueUrl: this.queueUrl,
                MessageBody: JSON.stringify(message),
                MessageGroupId: message.paymentId,
                MessageDeduplicationId: message.idempotencyKey,
            })
        )
    }
}