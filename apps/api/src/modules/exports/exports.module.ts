import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/index.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';

@Module({
  imports: [ApprovalsModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
