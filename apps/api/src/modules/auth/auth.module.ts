import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthGuard, CsrfGuard, PermissionGuard, StepUpGuard } from './guards.js';
import { KeycloakOidcProvider, OidcProvider } from './oidc.provider.js';
import { PrincipalService } from './principal.service.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    { provide: OidcProvider, useClass: KeycloakOidcProvider },
    SessionService,
    PrincipalService,
    AuthGuard,
    CsrfGuard,
    PermissionGuard,
    StepUpGuard,
  ],
  exports: [
    SessionService,
    PrincipalService,
    AuthGuard,
    CsrfGuard,
    PermissionGuard,
    StepUpGuard,
    OidcProvider,
  ],
})
export class AuthModule {}
