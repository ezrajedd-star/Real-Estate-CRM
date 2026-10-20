import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { CreateExportRequest } from '@crm/contracts';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe.js';
import { RateLimit } from '../../infra/rate-limit.js';
import { Can, StepUp } from '../auth/index.js';
import { ExportsService } from './exports.service.js';

const EXPORT_LIMIT = { bucket: 'export', limit: 10, windowSeconds: 3600 };

@Controller('exports')
@Can('export.request')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @RateLimit(EXPORT_LIMIT)
  request(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(CreateExportRequest)) body: z.infer<typeof CreateExportRequest>,
  ) {
    return this.exports.request(ctx, body.kind, body.filters, body.justification);
  }

  @Get()
  list(@CurrentCtx() ctx: AuthedCtx) {
    return this.exports.list(ctx);
  }

  @Post(':id/download')
  @StepUp()
  @RateLimit(EXPORT_LIMIT)
  async download(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Res() reply: FastifyReply,
  ) {
    const { filename, csv } = await this.exports.download(ctx, id);
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(csv);
  }
}
