import { Module } from '@nestjs/common';
import { AwsModule } from '../aws/aws.module';
import { PaymentGateway } from './gateway/payment.gateway';
import { SandboxGateway } from './gateway/sandbox.gateway';
import { PaymentsController } from './payments.controller';
import { PaymentsProcessor } from './payments.processor';
import { PaymentsQuery } from './payments.query';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PaymentsWorker } from './payments.worker';

@Module({
    imports: [AwsModule],
    controllers: [PaymentsController],
    providers: [
        PaymentsRepository,
        PaymentsService,
        PaymentsQuery,
        PaymentsProcessor,
        PaymentsWorker,
        { provide: PaymentGateway, useClass: SandboxGateway },
    ]
})
export class PaymentsModule {}