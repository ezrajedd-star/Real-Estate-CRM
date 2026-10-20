import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/index.js';
import { AuthModule } from '../auth/index.js';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { KeycloakAdminClient } from './keycloak-admin.js';

@Module({
  imports: [ApprovalsModule, AuthModule],
  controllers: [IdentityController],
  providers: [IdentityService, KeycloakAdminClient],
})
export class IdentityModule {}
