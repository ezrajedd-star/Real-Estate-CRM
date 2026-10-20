import {
  boolean,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const identity = pgSchema('identity');

export const appUser = identity.table('app_user', {
  id: uuid('id').primaryKey(),
  keycloakSub: text('keycloak_sub').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: ['ACTIVE', 'SUSPENDED', 'LEFT'] }).notNull(),
  isSystem: boolean('is_system').notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  leftAt: timestamp('left_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
});

export const rolePermission = identity.table(
  'role_permission',
  { role: text('role').notNull(), permission: text('permission').notNull() },
  (t) => [primaryKey({ columns: [t.role, t.permission] })],
);

export const roleAssignment = identity.table('role_assignment', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull(),
  scopeType: text('scope_type', { enum: ['GLOBAL', 'PROPERTY', 'COMPANY'] }).notNull(),
  scopeId: uuid('scope_id'),
  approvalRequestId: uuid('approval_request_id'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
  grantedBy: uuid('granted_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
});

export const userSession = identity.table('user_session', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  userAgent: text('user_agent'),
  ipHash: text('ip_hash'),
  amr: text('amr').array().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
});

export const breakGlassGrant = identity.table('break_glass_grant', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  reason: text('reason').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export const accessReview = identity.table('access_review', {
  id: uuid('id').primaryKey(),
  periodLabel: text('period_label').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
  generatedBy: uuid('generated_by').notNull(),
  snapshot: jsonb('snapshot').notNull(),
});
