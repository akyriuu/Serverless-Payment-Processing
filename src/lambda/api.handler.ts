import 'source-map-support/register';
import serverlessExpress from '@codegenie/serverless-express';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { APIGatewayProxyEventV2, Context, Handler } from 'aws-lambda';
import { AppModule, ObserveInstrument } from '../app.module'; 

let cached: Handler | undefined;

async function bootstrap(): Promise<Handler> { 
    const app = await NestFactory.create(AppModule, { 
        instrument: ObserveInstrument,
        bufferLogs: true,
    });

    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true}),
    );

    await app.init();

    return serverlessExpress({ app: app.getHttpAdapter().getInstance() });
}


export const handler = async (event: APIGatewayProxyEventV2, context: Context) => { 
    cached ??= await bootstrap();
    return cached(event, context, () => {});
}