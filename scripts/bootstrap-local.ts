import 'dotenv/config';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateTopicCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const region = process.env.AWS_REGION ?? 'us-east-1';
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

const sqs = new SQSClient({ region, endpoint });
const sns = new SNSClient({ region, endpoint });
const s3 = new S3Client({ region, endpoint, forcePathStyle: true });

const QUEUE_NAME = 'payments.fifo';
const DLQ_NAME = 'payments-dlq.fifo';
const TOPIC_NAME = 'payments-events';
const BUCKET_NAME = process.env.RECEIPTS_BUCKET ?? 'payments-receipts';

async function main(): Promise<void> {
  const dlqUrl = await ensureQueue(DLQ_NAME);
  const dlqArn = await getQueueArn(dlqUrl);

  const queueUrl = await ensureQueue(QUEUE_NAME, {
    DeduplicationScope: 'messageGroup',
    FifoThroughputLimit: 'perMessageGroupId',
    VisibilityTimeout: '60',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: '5',
    }),
  });

  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: TOPIC_NAME }));
  await ensureBucket(BUCKET_NAME);

  console.log('LocalStack is ready. These values belong in your .env:\n');
  console.log(`PAYMENTS_QUEUE_URL="${queueUrl}"`);
  console.log(`PAYMENTS_EVENTS_TOPIC_ARN="${TopicArn}"`);
  console.log(`RECEIPTS_BUCKET="${BUCKET_NAME}"`);
}

async function ensureQueue(
  name: string,
  attributes: Record<string, string> = {},
): Promise<string> {
  const url = await createQueue(name);

  if (Object.keys(attributes).length > 0) {
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: attributes }));
  }

  return url;
}

async function createQueue(name: string): Promise<string> {
  try {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }),
    );

    return QueueUrl!;
  } catch {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    return QueueUrl!;
  }
}

async function getQueueArn(queueUrl: string): Promise<string> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );

  return Attributes!.QueueArn!;
}

async function ensureBucket(name: string): Promise<void> {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: name }));
  } catch (error) {
    const code = (error as { name?: string }).name;

    if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
      throw error;
    }
  }
}

void main();