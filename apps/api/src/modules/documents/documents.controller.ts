import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { InitiateUploadRequest } from '@crm/contracts';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe.js';
import { RateLimit } from '../../infra/rate-limit.js';
import { Can } from '../auth/index.js';
import { DocumentsService } from './documents.service.js';

const FILE_LIMIT = { bucket: 'file', limit: 60, windowSeconds: 600 };
const ListQuery = z.object({
  ownerType: z.string().regex(/^[a-z_]{2,30}$/),
  ownerId: z.string().uuid(),
});

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @Can('document.upload')
  @RateLimit(FILE_LIMIT)
  initiate(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(InitiateUploadRequest)) body: z.infer<typeof InitiateUploadRequest>,
  ) {
    return this.documents.initiateUpload(ctx, body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Can('document.upload')
  complete(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.documents.completeUpload(ctx, id);
  }

  @Get()
  list(@CurrentCtx() ctx: AuthedCtx, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.documents.listFor(ctx, q.ownerType, q.ownerId);
  }

  @Get(':id')
  get(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.documents.get(ctx, id);
  }

  @Post(':id/download-url')
  @HttpCode(200)
  @RateLimit(FILE_LIMIT)
  downloadUrl(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.documents.downloadUrl(ctx, id);
  }
}
