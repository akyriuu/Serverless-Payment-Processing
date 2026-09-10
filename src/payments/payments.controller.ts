import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
  } from '@nestjs/common';
  import { CreatePaymentDto } from './dto/create-payment.dto';
  import { FindPaymentsDto } from './dto/find-payments.dto';
  import { PaymentsQuery } from './payments.query';
  import { PaymentsService } from './payments.service';


  @Controller('payments')
  export class PaymentsController { 
    constructor(
        private readonly payments: PaymentsService,
        private readonly query: PaymentsQuery,
    ) {}

    @Post()
    @HttpCode(HttpStatus.ACCEPTED)
    create(
        @Headers('idempotency-key') idempotencyKey: string | undefined,
        @Body() dto: CreatePaymentDto,
    ) { 
        if (!idempotencyKey) { 
            throw new BadRequestException('Idempotency-Key header is required');
        }

        return this.payments.create({ ...dto, idempotencyKey });
    }

    @Get()
    list(@Query() query: FindPaymentsDto) { 
        return this.query.list(query);
    }

    @Get(':id')
    get(@Param('id') id: string) { 
        return this.query.get(id);
    }
  }