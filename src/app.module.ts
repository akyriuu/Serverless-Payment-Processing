import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';

export const { ObserveModule, ObserveInstrument }  = createObserveModule();

@Module({
    imports: [
        ObserveModule.forRoot({
            appKey: process.env.OBSERVE_APP_KEY ?? '',
            appSecret: process.env.OBSERVE_APP_SECRET ?? '',
            serviceId: 'serverless-processing-payment',
        }),
        PrismaModule,
        PaymentsModule,
    ],
})
export class AppModule {}