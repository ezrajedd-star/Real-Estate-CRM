import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import * as c from '@crm/contracts';
import { z } from '@crm/contracts';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * OpenAPI 3.1 document generated from the same Zod schemas the API validates with, so the
 * spec cannot drift from the implementation. Served to signed-in staff at /api/v1/openapi.json.
 */
export function buildOpenApiDocument() {
  const r = new OpenAPIRegistry();
  r.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: '__Host-sid',
    description:
      'Server-side session cookie set by /auth/callback. State-changing requests also need the x-csrf-token header from /auth/me.',
  });

  const id = z.object({ id: c.Uuid });
  const json = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });
  const route = (
    method: Method,
    path: string,
    summary: string,
    opts: {
      tag: string;
      body?: z.ZodTypeAny;
      params?: z.AnyZodObject;
      query?: z.AnyZodObject;
      response?: z.ZodTypeAny;
      permission?: string;
      stepUp?: boolean;
    },
  ) =>
    r.registerPath({
      method,
      path,
      summary,
      tags: [opts.tag],
      description: [
        opts.permission && `Requires permission \`${opts.permission}\`.`,
        opts.stepUp && 'Requires recent re-authentication (step-up).',
      ]
        .filter(Boolean)
        .join(' '),
      security: [{ session: [] }],
      request: {
        ...(opts.params && { params: opts.params }),
        ...(opts.query && { query: opts.query }),
        ...(opts.body && { body: json(opts.body) }),
      },
      responses: {
        200: { description: 'OK', ...(opts.response && json(opts.response)) },
        400: { description: 'Validation failed', ...json(c.ErrorBody) },
        401: { description: 'Not signed in / step-up required', ...json(c.ErrorBody) },
        403: { description: 'Forbidden', ...json(c.ErrorBody) },
        404: { description: 'Not found (or not in your scope)', ...json(c.ErrorBody) },
        429: { description: 'Rate limited', ...json(c.ErrorBody) },
      },
    });

  route('get', '/auth/me', 'Current user, permissions and CSRF token', {
    tag: 'auth',
    response: c.MeDto,
  });
  route('get', '/auth/sessions', 'My active sessions', {
    tag: 'auth',
    response: z.array(c.SessionDto),
  });
  route('post', '/auth/logout', 'Sign out', { tag: 'auth' });

  route('get', '/users', 'List staff users', {
    tag: 'identity',
    permission: 'user.read',
    response: z.array(c.UserSummaryDto),
  });
  route('post', '/users/{id}/role-changes', 'Request a role change (maker–checker)', {
    tag: 'identity',
    params: id,
    body: c.RoleChangeRequest,
    permission: 'user.propose_role_change',
    stepUp: true,
    response: c.ApprovalDto,
  });
  route('post', '/users/{id}/offboard', 'Leaver process: block access, revoke sessions', {
    tag: 'identity',
    params: id,
    body: c.OffboardRequest,
    permission: 'user.revoke_sessions',
    stepUp: true,
  });
  route('post', '/break-glass', 'Start emergency read access (alerts security)', {
    tag: 'identity',
    body: c.BreakGlassRequest,
    permission: 'break_glass.use',
    stepUp: true,
  });

  route('get', '/approvals', 'Approvals inbox', {
    tag: 'approvals',
    response: z.array(c.ApprovalDto),
  });
  route('post', '/approvals/{id}/decision', 'Approve or reject', {
    tag: 'approvals',
    params: id,
    body: c.DecisionRequest,
    response: c.ApprovalDto,
  });

  route('get', '/config/values', 'Effective-dated config values', {
    tag: 'config',
    permission: 'config.read',
    response: z.array(c.ConfigValueDto),
  });
  route('get', '/config/tax-rates', 'Effective-dated tax rates', {
    tag: 'config',
    permission: 'config.read',
    response: z.array(c.TaxRateDto),
  });
  route('get', '/config/feature-flags', 'Feature flags', {
    tag: 'config',
    response: z.array(c.FeatureFlagDto),
  });
  route('post', '/config/changes', 'Propose a config/rate/flag change (maker–checker)', {
    tag: 'config',
    body: c.ConfigChangeRequest,
    permission: 'config.propose',
    response: c.ApprovalDto,
  });

  route('get', '/properties', 'Properties in my scope', {
    tag: 'contacts',
    permission: 'property.read',
    response: z.array(c.PropertyDto),
  });
  route('get', '/companies', 'Search companies in my scope', {
    tag: 'contacts',
    query: c.CompanySearchQuery,
    permission: 'company.read',
  });
  route('post', '/companies', 'Create a company', {
    tag: 'contacts',
    body: c.CreateCompanyRequest,
    permission: 'company.write',
    response: c.CompanyDto,
  });
  route('get', '/companies/{id}', 'Get a company (masked)', {
    tag: 'contacts',
    params: id,
    permission: 'company.read',
    response: c.CompanyDto,
  });
  route('patch', '/companies/{id}', 'Update a company', {
    tag: 'contacts',
    params: id,
    body: c.UpdateCompanyRequest,
    permission: 'company.write',
    response: c.CompanyDto,
  });
  route('post', '/companies/{id}/reveal', 'Reveal the TIN (reason required, audited)', {
    tag: 'contacts',
    params: id,
    body: c.RevealRequest,
    permission: 'pii.reveal.tin',
    response: c.RevealResponse,
  });
  route('put', '/companies/{id}/kyc', 'Create/update KYC profile', {
    tag: 'contacts',
    params: id,
    body: c.UpsertKycRequest,
    permission: 'kyc.write',
    response: c.KycDto,
  });
  route('post', '/companies/{id}/bank-accounts', 'Add a bank account (encrypted)', {
    tag: 'contacts',
    params: id,
    body: c.CreateBankAccountRequest,
    permission: 'kyc.write',
    stepUp: true,
    response: c.BankAccountDto,
  });
  route('post', '/people', 'Create a person', {
    tag: 'contacts',
    body: c.CreatePersonRequest,
    permission: 'contact.write',
    response: c.PersonDto,
  });
  route('post', '/people/search', 'Find people by email or name (body, never URL)', {
    tag: 'contacts',
    body: c.PersonSearchRequest,
    permission: 'contact.read',
    response: z.array(c.PersonDto),
  });
  route('post', '/people/{id}/consents', 'Record consent / acknowledgement', {
    tag: 'privacy',
    params: id,
    body: c.CaptureConsentRequest,
    permission: 'consent.write',
    response: c.ConsentDto,
  });
  route('post', '/privacy-notices', 'Publish a privacy notice version', {
    tag: 'privacy',
    body: c.PublishNoticeRequest,
    permission: 'privacy.manage',
    response: c.PrivacyNoticeDto,
  });

  route('post', '/documents', 'Start an upload (returns a 5-minute presigned PUT URL)', {
    tag: 'documents',
    body: c.InitiateUploadRequest,
    permission: 'document.upload',
    response: c.InitiateUploadResponse,
  });
  route('post', '/documents/{id}/complete', 'Confirm upload; queues malware scan', {
    tag: 'documents',
    params: id,
    permission: 'document.upload',
    response: c.DocumentDto,
  });
  route('post', '/documents/{id}/download-url', 'Issue a 5-minute download URL (audited)', {
    tag: 'documents',
    params: id,
    response: c.DownloadUrlResponse,
  });

  route('post', '/imports', 'Create an Excel import from an uploaded workbook', {
    tag: 'imports',
    body: c.CreateImportRequest,
    permission: 'import.run',
    response: c.ImportBatchDto,
  });
  route('post', '/imports/{id}/validate', 'Validate rows and preview errors', {
    tag: 'imports',
    params: id,
    permission: 'import.run',
    response: c.ImportPreviewDto,
  });
  route('post', '/imports/{id}/commit', 'Commit a valid import (idempotent)', {
    tag: 'imports',
    params: id,
    permission: 'import.run',
    response: c.ImportPreviewDto,
  });

  route('post', '/exports', 'Request a bulk export (needs approval)', {
    tag: 'exports',
    body: c.CreateExportRequest,
    permission: 'export.request',
  });
  route('post', '/exports/{id}/download', 'Download an approved export once (watermarked CSV)', {
    tag: 'exports',
    params: id,
    permission: 'export.request',
    stepUp: true,
  });

  return new OpenApiGeneratorV31(r.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Commercial Leasing CRM API',
      version: '1.0.0',
      description:
        'Staff API. All routes are under /api/v1. PII is masked by default; reveals are audited.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
