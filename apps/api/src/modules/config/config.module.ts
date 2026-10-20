import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/index.js';
import { ConfigController } from './config.controller.js';
import { ConfigService } from './config.service.js';

@Module({
  imports: [ApprovalsModule],
  controllers: [ConfigController],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
