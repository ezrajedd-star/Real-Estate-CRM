import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigChangeRequest } from '@crm/contracts';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Can } from '../auth/index.js';
import { ConfigService } from './config.service.js';

@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get('values')
  @Can('config.read')
  async values(@CurrentCtx() ctx: AuthedCtx) {
    return (await this.config.listValues(ctx)).map((r) => ({
      id: r.id,
      key: r.key,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      value: r.value,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      needsConfirmation: r.needsConfirmation,
      notes: r.notes,
    }));
  }

  @Get('tax-rates')
  @Can('config.read')
  async taxRates(@CurrentCtx() ctx: AuthedCtx) {
    return (await this.config.listTaxRates(ctx)).map((r) => ({
      id: r.id,
      taxType: r.taxType,
      rate: r.rate,
      brackets: r.brackets,
      basis: r.basis,
      sourceReference: r.sourceReference,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      needsConfirmation: r.needsConfirmation,
    }));
  }

  @Get('feature-flags')
  async flags(@CurrentCtx() ctx: AuthedCtx) {
    return (await this.config.listFlags(ctx)).map((f) => ({
      key: f.key,
      enabled: f.enabled,
      description: f.description,
      updatedAt: f.updatedAt.toISOString(),
    }));
  }

  /** Creates a CONFIG_CHANGE approval request; nothing changes until a checker approves. */
  @Post('changes')
  @Can('config.propose')
  propose(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(ConfigChangeRequest)) body: ConfigChangeRequest,
  ) {
    return this.config.propose(ctx, body);
  }
}
