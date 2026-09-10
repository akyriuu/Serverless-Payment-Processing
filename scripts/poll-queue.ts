import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  DeleteMessageBatchCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { AppModule } from '../src/app.module';
import { getEnv } from '../src/config/env';
import { PaymentsWorker } from '../src/payments/payments.worker';

const env = getEnv();
const logger = new Logger('QueuePoller');

const client = new SQSClient({
  region: env.AWS_REGION,
  endpoint: env.AWS_ENDPOINT_URL,
});

let running = true;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(PaymentsWorker);

  process.on('SIGINT', () => {
    logger.log('draining the current batch before exiting');
    running = false;
  });

  logger.log(`polling ${env.PAYMENTS_QUEUE_URL}`);

  while (running) {
    try {
      const messages = await receive();
      if (messages.length === 0) continue;

      const { batchItemFailures } = await worker.handle(toEvent(messages));
      const failed = new Set(batchItemFailures.map((failure) => failure.itemIdentifier));

      await acknowledge(messages.filter((message) => !failed.has(message.MessageId!)));
    } catch (error) {
      logger.error(`poll cycle failed: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  await app.close();
}

async function receive(): Promise<Message[]> {
  const { Messages } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: env.PAYMENTS_QUEUE_URL,
      MaxNumberOfMessages: 5,
      WaitTimeSeconds: 20,
      MessageSystemAttributeNames: ['All'],
    }),
  );

  return Messages ?? [];
}

async function acknowledge(messages: Message[]): Promise<void> {
  if (messages.length === 0) return;

  await client.send(
    new DeleteMessageBatchCommand({
      QueueUrl: env.PAYMENTS_QUEUE_URL,
      Entries: messages.map((message) => ({
        Id: message.MessageId,
        ReceiptHandle: message.ReceiptHandle,
      })),
    }),
  );
}

function toEvent(messages: Message[]): SQSEvent {
  return { Records: messages.map(toRecord) };
}

function toRecord(message: Message): SQSRecord {
  const attributes = message.Attributes ?? {};

  return {
    messageId: message.MessageId!,
    receiptHandle: message.ReceiptHandle!,
    body: message.Body!,
    md5OfBody: message.MD5OfBody!,
    messageAttributes: {},
    attributes: {
      ApproximateReceiveCount: attributes.ApproximateReceiveCount ?? '1',
      ApproximateFirstReceiveTimestamp: attributes.ApproximateFirstReceiveTimestamp ?? '0',
      SentTimestamp: attributes.SentTimestamp ?? '0',
      SenderId: attributes.SenderId ?? 'local',
      SequenceNumber: attributes.SequenceNumber,
      MessageGroupId: attributes.MessageGroupId,
      MessageDeduplicationId: attributes.MessageDeduplicationId,
    },
    eventSource: 'aws:sqs',
    eventSourceARN: `arn:aws:sqs:${env.AWS_REGION}:000000000000:payments.fifo`,
    awsRegion: env.AWS_REGION,
  };
}

void main();