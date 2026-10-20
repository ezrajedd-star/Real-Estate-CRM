import { bigint, jsonb, pgSchema, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const audit = pgSchema('audit');

/** Insert-only. seq, occurred_at, actor, request id, IP hash and hashes are set by trigger. */
export const auditLog = audit.table('audit_log', {
  seq: bigint('seq', { mode: 'number' }).primaryKey(),
  id: uuid('id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  actorId: uuid('actor_id'),
  actorType: text('actor_type', { enum: ['USER', 'SYSTEM', 'ANONYMOUS'] }).notNull(),
  action: text('action').notNull(),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  outcome: text('outcome', { enum: ['SUCCESS', 'FAILURE', 'DENIED'] }).notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  requestId: text('request_id'),
  ipHash: text('ip_hash'),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

export const shipCursor = audit.table('ship_cursor', {
  id: smallint('id').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
  lastHash: text('last_hash'),
  lastObjectKey: text('last_object_key'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const securityAlert = audit.table('security_alert', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  severity: text('severity', { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }).notNull(),
  subjectUserId: uuid('subject_user_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: uuid('acknowledged_by'),
});
