import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getEnv } from '../config/env';
import type { Payment } from '../generated/prisma/client';
import type { ChargeResult } from '../payments/gateway/payment.gateway';

export type StoredReceipt = { 
    bucket: string;
    objectKey: string;
    checksum: string;
    bytes: number;
};

@Injectable()
export class ReceiptsStorage { 
    private readonly client = new S3Client({
        region: getEnv().AWS_REGION,
        endpoint: getEnv().AWS_ENDPOINT_URL,
        forcePathStyle: Boolean(getEnv().AWS_ENDPOINT_URL),
    })
    private readonly bucket = getEnv().RECEIPTS_BUCKET;

    async save(payment: Payment, charge: ChargeResult): Promise<StoredReceipt> { 
        const body = Buffer.from(
            JSON.stringify(
                {
                    paymentId: payment.id,
                    customerId: payment.customerId,
                    amountCents: payment.amountCents,
                    currency: payment.currency,
                    method: payment.method,
                    providerRef: charge.providerRef,
                    authorizedAt: charge.authorizedAt.toISOString(),
                },
                null,
                2,
            ),
        );

        const digest = createHash('sha256').update(body).digest();
        const objectKey = this.buildKey(payment);

        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: objectKey,
                Body: body,
                ContentType: 'application/json',
                ChecksumSHA256: digest.toString('base64'),
                Metadata: { paymentId: payment.id, providerRef: charge.providerRef },
            }),
        );

        return { 
            bucket: this.bucket,
            objectKey,
            checksum: digest.toString('hex'),
            bytes: body.byteLength,
        }
    }

    private buildKey(payment: Payment): string {
        const date = payment.createdAt.toISOString().slice(0, 10).replaceAll('-', '/');
        return `receipts/${date}/${payment.id}.json`;
     }
}