import { z } from 'zod';

const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    AWS_REGION: z.string().min(1),
    AWS_ENDPOINT_URL: z.string().url().optional(),
    DATABASE_URL: z.string().min(1),
    PAYMENTS_QUEUE_URL: z.string().url(),
    PAYMENTS_EVENTS_TOPIC_ARN: z.string().min(1),
    RECEIPTS_BUCKET: z.string().min(1),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env { 
    cached ??= schema.parse(process.env);
    return cached;
}