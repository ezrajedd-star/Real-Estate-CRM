import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { BreakGlassRequest, OffboardRequest, RoleChangeRequest } from '@crm/contracts';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe.js';
import { RateLimit } from '../../infra/rate-limit.js';
import { Can, StepUp } from '../auth/index.js';
import { IdentityService } from './identity.service.js';

const AccessReviewRequest = z.object({ periodLabel: z.string().regex(/^\d{4}-Q[1-4]$/) });

@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Get('users')
  @Can('user.read')
  listUsers(@CurrentCtx() ctx: AuthedCtx) {
    return this.identity.listUsers(ctx);
  }

  @Get('users/:id')
  @Can('user.read')
  getUser(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.identity.getUser(ctx, id);
  }

  @Post('users/:id/role-changes')
  @Can('user.propose_role_change')
  @StepUp()
  proposeRoleChange(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(RoleChangeRequest)) body: z.infer<typeof RoleChangeRequest>,
  ) {
    return this.identity.proposeRoleChange(ctx, id, body);
  }

  @Post('users/:id/offboard')
  @HttpCode(200)
  @Can('user.revoke_sessions')
  @StepUp()
  offboard(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(OffboardRequest)) body: z.infer<typeof OffboardRequest>,
  ) {
    return this.identity.offboard(ctx, id, body.reason);
  }

  @Post('break-glass')
  @Can('break_glass.use')
  @StepUp()
  @RateLimit({ bucket: 'break-glass', limit: 3, windowSeconds: 3600 })
  startBreakGlass(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(BreakGlassRequest)) body: z.infer<typeof BreakGlassRequest>,
  ) {
    return this.identity.startBreakGlass(ctx, body.reason, body.minutes);
  }

  @Delete('break-glass')
  @HttpCode(204)
  endBreakGlass(@CurrentCtx() ctx: AuthedCtx) {
    return this.identity.endBreakGlass(ctx);
  }

  @Post('access-reviews')
  @Can('access_review.run')
  accessReview(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(AccessReviewRequest)) body: z.infer<typeof AccessReviewRequest>,
  ) {
    return this.identity.generateAccessReview(ctx, body.periodLabel);
  }

  @Get('access-reviews')
  @Can('access_review.run')
  listAccessReviews(@CurrentCtx() ctx: AuthedCtx) {
    return this.identity.listAccessReviews(ctx);
  }
}
