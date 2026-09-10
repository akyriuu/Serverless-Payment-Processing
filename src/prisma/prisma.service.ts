import { Injectable, OnModuleDestroy, OnModuleInit  } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';


@Injectable()
export class PrismaService 
    extends PrismaClient 
    implements OnModuleInit, OnModuleDestroy 
{ 
    constructor() { 
        super({
            // env lambda vai 1 request por vez aqui 
            
            adapter: new PrismaPg({
                connectionString: process.env.DATABASE_URL,
                max: 2,
                idleTimeoutMillis: 10_000,
            }),
        });
    }

    async onModuleInit(): Promise<void> { 
        await this.$connect();
    }

    async onModuleDestroy(): Promise<void> { 
        await this.$disconnect();
    }    
}