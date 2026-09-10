import 'source-map-support/register';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { AppModule } from '../app.module';
import { PaymentsWorker } from '../payments/payments.worker';

let cached: INestApplicationContext | undefined;

async function bootstrap(): Promise<INestApplicationContext> { 
    const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
        app.enableShutdownHooks();
        return app;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    cached ??= await bootstrap();
    return cached.get(PaymentsWorker).handle(event);
}