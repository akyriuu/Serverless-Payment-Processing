import { z } from 'zod';

export const processPaymentMessageSchema = z.object({
    paymentId: z.string().min(1),
    idempotencyKey: z.string().min(1),
});

export type ProcessPaymentMessage = z.infer<typeof processPaymentMessageSchema>;