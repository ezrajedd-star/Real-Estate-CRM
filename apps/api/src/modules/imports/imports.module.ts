import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/index.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [DocumentsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
