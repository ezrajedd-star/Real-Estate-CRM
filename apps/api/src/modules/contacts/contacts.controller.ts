import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  AddContactRoleRequest,
  CaptureConsentRequest,
  CompanySearchQuery,
  CreateBankAccountRequest,
  CreateCompanyRequest,
  CreatePersonRequest,
  CreatePropertyRequest,
  EndContactRoleRequest,
  LinkPropertyRequest,
  PersonSearchRequest,
  PublishNoticeRequest,
  RevealRequest,
  UpdateCompanyRequest,
  UpsertKycRequest,
} from '@crm/contracts';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe.js';
import { RateLimit } from '../../infra/rate-limit.js';
import { Can, StepUp } from '../auth/index.js';
import { ContactsService } from './contacts.service.js';
import { KycService } from './kyc.service.js';

const REVEAL_LIMIT = { bucket: 'reveal', limit: 30, windowSeconds: 3600 };
const SEARCH_LIMIT = { bucket: 'search', limit: 60, windowSeconds: 60 };

@Controller()
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly kyc: KycService,
  ) {}

  // ------------------------------------------------------------ properties

  @Get('properties')
  @Can('property.read')
  async properties(@CurrentCtx() ctx: AuthedCtx) {
    return (await this.contacts.listProperties(ctx)).map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      address: p.address,
    }));
  }

  @Post('properties')
  @Can('property.write')
  async createProperty(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(CreatePropertyRequest)) body: z.infer<typeof CreatePropertyRequest>,
  ) {
    const p = await this.contacts.createProperty(ctx, {
      code: body.code,
      name: body.name,
      address: body.address ?? null,
    });
    return { id: p.id, code: p.code, name: p.name, address: p.address };
  }

  // ------------------------------------------------------------ companies

  @Get('companies')
  @Can('company.read')
  @RateLimit(SEARCH_LIMIT)
  search(
    @CurrentCtx() ctx: AuthedCtx,
    @Query(new ZodPipe(CompanySearchQuery)) q: z.infer<typeof CompanySearchQuery>,
  ) {
    return this.contacts.searchCompanies(ctx, q);
  }

  @Post('companies')
  @Can('company.write')
  create(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(CreateCompanyRequest)) body: z.infer<typeof CreateCompanyRequest>,
  ) {
    return this.contacts.createCompany(ctx, body);
  }

  @Get('companies/:id')
  @Can('company.read')
  get(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.contacts.getCompany(ctx, id);
  }

  @Patch('companies/:id')
  @Can('company.write')
  update(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(UpdateCompanyRequest)) body: z.infer<typeof UpdateCompanyRequest>,
  ) {
    return this.contacts.updateCompany(ctx, id, body);
  }

  @Post('companies/:id/reveal')
  @HttpCode(200)
  @RateLimit(REVEAL_LIMIT)
  revealCompany(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(RevealRequest)) body: z.infer<typeof RevealRequest>,
  ) {
    return this.contacts.revealCompanyField(ctx, id, body.field, body.reason);
  }

  @Post('companies/:id/properties')
  @HttpCode(204)
  @Can('company.write')
  linkProperty(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(LinkPropertyRequest)) body: z.infer<typeof LinkPropertyRequest>,
  ) {
    return this.contacts.linkProperty(ctx, id, body.propertyId, body.relation);
  }

  @Post('companies/:id/contacts')
  @Can('contact.write')
  addContact(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(AddContactRoleRequest)) body: z.infer<typeof AddContactRoleRequest>,
  ) {
    return this.contacts.addContactRole(ctx, id, body);
  }

  @Post('companies/:id/contacts/:roleId/end')
  @HttpCode(204)
  @Can('contact.write')
  endContact(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Param('roleId', UuidPipe) roleId: string,
    @Body(new ZodPipe(EndContactRoleRequest)) body: z.infer<typeof EndContactRoleRequest>,
  ) {
    return this.contacts.endContactRole(ctx, id, roleId, body.effectiveTo);
  }

  // ------------------------------------------------------------ KYC & bank

  @Get('companies/:id/kyc')
  @Can('kyc.read')
  getKyc(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.kyc.getKyc(ctx, id);
  }

  @Put('companies/:id/kyc')
  @Can('kyc.write')
  upsertKyc(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(UpsertKycRequest)) body: z.infer<typeof UpsertKycRequest>,
  ) {
    return this.kyc.upsertKyc(ctx, id, body);
  }

  @Get('companies/:id/bank-accounts')
  @Can('kyc.read')
  bankAccounts(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.kyc.listBankAccounts(ctx, id);
  }

  /** Changing bank details is a classic fraud vector: step-up required. */
  @Post('companies/:id/bank-accounts')
  @Can('kyc.write')
  @StepUp()
  addBankAccount(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(CreateBankAccountRequest)) body: z.infer<typeof CreateBankAccountRequest>,
  ) {
    return this.kyc.addBankAccount(ctx, id, body);
  }

  @Post('companies/:id/bank-accounts/:accountId/reveal')
  @HttpCode(200)
  @Can('pii.reveal.bank')
  @RateLimit(REVEAL_LIMIT)
  revealBank(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Param('accountId', UuidPipe) accountId: string,
    @Body(new ZodPipe(RevealRequest)) body: z.infer<typeof RevealRequest>,
  ) {
    return this.kyc.revealBankAccount(ctx, id, accountId, body.reason);
  }

  // ------------------------------------------------------------ people

  @Post('people')
  @Can('contact.write')
  createPerson(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(CreatePersonRequest)) body: z.infer<typeof CreatePersonRequest>,
  ) {
    return this.contacts.createPerson(ctx, body);
  }

  /** Contacts API (v1) — also the integration point for the future Residential system. */
  @Post('people/search')
  @HttpCode(200)
  @Can('contact.read')
  @RateLimit(SEARCH_LIMIT)
  searchPeople(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(PersonSearchRequest)) body: z.infer<typeof PersonSearchRequest>,
  ) {
    return this.contacts.searchPeople(ctx, body);
  }

  @Get('people/:id')
  @Can('contact.read')
  getPerson(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return this.contacts.getPerson(ctx, id);
  }

  @Post('people/:id/reveal')
  @HttpCode(200)
  @RateLimit(REVEAL_LIMIT)
  revealPerson(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(RevealRequest)) body: z.infer<typeof RevealRequest>,
  ) {
    return this.contacts.revealPersonField(ctx, id, body.field, body.reason);
  }

  @Get('people/:id/consents')
  @Can('contact.read')
  async consents(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    return (await this.kyc.listConsents(ctx, id)).map((c) => ({
      ...c,
      capturedAt: c.capturedAt.toISOString(),
    }));
  }

  @Post('people/:id/consents')
  @Can('consent.write')
  async captureConsent(
    @CurrentCtx() ctx: AuthedCtx,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(CaptureConsentRequest)) body: z.infer<typeof CaptureConsentRequest>,
  ) {
    const c = await this.kyc.captureConsent(ctx, id, body);
    return { ...c, capturedAt: c.capturedAt.toISOString() };
  }

  // ------------------------------------------------------------ privacy notices

  @Get('privacy-notices')
  async notices(@CurrentCtx() ctx: AuthedCtx) {
    return (await this.kyc.listNotices(ctx)).map((n) => ({
      ...n,
      publishedAt: n.publishedAt.toISOString(),
    }));
  }

  @Post('privacy-notices')
  @Can('privacy.manage')
  async publishNotice(
    @CurrentCtx() ctx: AuthedCtx,
    @Body(new ZodPipe(PublishNoticeRequest)) body: z.infer<typeof PublishNoticeRequest>,
  ) {
    const n = await this.kyc.publishNotice(ctx, body);
    return { ...n, publishedAt: n.publishedAt.toISOString() };
  }
}
