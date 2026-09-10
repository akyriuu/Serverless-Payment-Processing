import { Injectable } from '@nestjs/common';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { getEnv } from '../config/env';

export type  PaymentEventPayload = { 
    type: 'payment.succeeded' | 'payment.failed';
    paymentId: string;
    customerId: string;
    status: string;
    occurredAt: string;
};

@Injectable()
export class PaymentEventsPublisher { 
    private readonly client = new SNSClient({
        region: getEnv().AWS_REGION,
        endpoint: getEnv().AWS_ENDPOINT_URL,
    });
    private readonly topicArn = getEnv().PAYMENTS_EVENTS_TOPIC_ARN;

    async publish(event: PaymentEventPayload): Promise<void> { 
        await this.client.send(
                new PublishCommand({
                    TopicArn: this.topicArn,
                    Subject: event.type,
                    Message: JSON.stringify(event),
                    MessageAttributes: { 
                        type: { DataType: 'String', StringValue: event.type },
                        status: { DataType: 'String', StringValue: event.status },
                    }
                })
            )
    }
}