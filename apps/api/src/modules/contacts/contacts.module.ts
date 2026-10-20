import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller.js';
import { ContactsService } from './contacts.service.js';
import { KycService } from './kyc.service.js';

@Module({
  controllers: [ContactsController],
  providers: [ContactsService, KycService],
  exports: [ContactsService],
})
export class ContactsModule {}
