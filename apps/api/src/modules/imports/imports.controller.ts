import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { z } from 'zod';
import { CreateImportRequest } from '@crm/contracts';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe.js';
import { RateLimit } from '../../infra/rate-limit.js';
import { Can } from '../auth/index.js';
import { ImportsService } from './imports.service.js';

const IMPORT_LIMIT = { bucket: 'import', limit: 20, windowSeconds: 3600 };

@Controller('imports')
@Can('import.run')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post()
  @RateLimit(IMPORT_LIMIT)
  create(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(CreateImportRequest)) body: z.infer<typeof CreateImportRequest>,
  ) {
    return this.imports.create(ctx, body);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @RateLimit(IMPORT_LIMIT)
  validate(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.imports.validate(ctx, id);
  }

  @Get(':id')
  preview(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.imports.preview(ctx, id);
  }

  @Post(':id/commit')
  @HttpCode(200)
  commit(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.imports.commit(ctx, id);
  }
}
