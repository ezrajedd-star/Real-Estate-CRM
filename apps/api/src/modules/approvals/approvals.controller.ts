import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DecisionRequest } from '@crm/contracts';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe.js';
import { ApprovalsService } from './approvals.service.js';

const ListQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  type: z.enum(['ROLE_CHANGE', 'CONFIG_CHANGE', 'BULK_EXPORT']).optional(),
});

/** Approvals inbox. Visibility is enforced by RLS: makers see theirs, checkers see their queue. */
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@CurrentCtx() ctx: AuthedCtx, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.approvals.list(ctx, q);
  }

  @Get(':id')
  get(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.approvals.get(ctx, id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(DecisionRequest)) body: z.infer<typeof DecisionRequest>,
  ) {
    return this.approvals.decide(ctx, id, body.decision, body.comment);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  cancel(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.approvals.cancel(ctx, id);
  }
}
