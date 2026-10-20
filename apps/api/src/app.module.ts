import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { InfraModule } from './infra/infra.module.js';
import { RateLimitGuard } from './infra/rate-limit.js';
import { ApprovalsModule } from './modules/approvals/index.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/index.js';
import { AuthGuard, CsrfGuard, PermissionGuard, StepUpGuard } from './modules/auth/guards.js';
import { ConfigModule } from './modules/config/config.module.js';
import { ContactsModule } from './modules/contacts/index.js';
import { DocumentsModule } from './modules/documents/index.js';
import { ExportsModule } from './modules/exports/exports.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { ImportsModule } from './modules/imports/imports.module.js';
import { OpenApiModule } from './openapi/openapi.module.js';

@Module({
  imports: [
    InfraModule,
    AuthModule,
    ApprovalsModule,
    IdentityModule,
    ConfigModule,
    ContactsModule,
    DocumentsModule,
    ImportsModule,
    ExportsModule,
    AuditModule,
    HealthModule,
    OpenApiModule,
  ],
  providers: [
    // Guards run in this order: who are you → is this request forged → may you →
    // did you re-authenticate recently → are you going too fast.
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useExisting: CsrfGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard },
    { provide: APP_GUARD, useExisting: StepUpGuard },
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
