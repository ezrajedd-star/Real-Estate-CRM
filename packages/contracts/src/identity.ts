import { PERMISSIONS, SCOPE_TYPES, STAFF_ROLES } from '@crm/domain';
import { Reason, Text, Uuid, z } from './common.js';

export const StaffRoleSchema = z.enum(STAFF_ROLES);
export const PermissionSchema = z.enum(PERMISSIONS);
export const ScopeTypeSchema = z.enum(SCOPE_TYPES);

export const RoleGrantDto = z
  .object({
    id: Uuid,
    role: StaffRoleSchema,
    scopeType: ScopeTypeSchema,
    scopeId: Uuid.nullable(),
    grantedAt: z.string().datetime(),
  })
  .openapi('RoleGrant');

export const MeDto = z
  .object({
    id: Uuid,
    displayName: z.string(),
    email: z.string(),
    grants: z.array(RoleGrantDto),
    permissions: z.array(PermissionSchema),
    csrfToken: z.string(),
    session: z.object({
      idleExpiresAt: z.string().datetime(),
      absoluteExpiresAt: z.string().datetime(),
      authTime: z.string().datetime(),
      amr: z.array(z.string()),
    }),
    breakGlassUntil: z.string().datetime().nullable(),
  })
  .openapi('Me');

export const SessionDto = z
  .object({
    id: z.string(),
    current: z.boolean(),
    createdAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    userAgent: z.string().nullable(),
    absoluteExpiresAt: z.string().datetime(),
  })
  .openapi('Session');

export const UserSummaryDto = z
  .object({
    id: Uuid,
    displayName: z.string(),
    email: z.string(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'LEFT']),
    lastLoginAt: z.string().datetime().nullable(),
    grants: z.array(RoleGrantDto),
  })
  .openapi('UserSummary');

export const RoleChangeRequest = z
  .discriminatedUnion('action', [
    z.object({
      action: z.literal('GRANT'),
      role: StaffRoleSchema,
      scopeType: ScopeTypeSchema,
      scopeId: Uuid.nullable().default(null),
      justification: Text(500, 10),
    }),
    z.object({ action: z.literal('REVOKE'), assignmentId: Uuid, justification: Text(500, 10) }),
  ])
  .superRefine((v, ctx) => {
    if (v.action === 'GRANT' && (v.scopeType === 'GLOBAL') !== (v.scopeId === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scopeId'],
        message: 'GLOBAL scope has no scopeId; other scopes require one',
      });
    }
  })
  .openapi('RoleChangeRequest');

export const OffboardRequest = z.object({ reason: Reason }).openapi('OffboardRequest');

export const BreakGlassRequest = z
  .object({ reason: Text(500, 15), minutes: z.number().int().min(5).max(120).default(30) })
  .openapi('BreakGlassRequest');
