import { sql } from 'drizzle-orm';
import { bigint, jsonb, pgSchema, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const audit = pgSchema('audit');

/** Insert-only. seq, occurred_at, actor, request id, IP hash and hashes are set by trigger. */
export const auditLog = audit.table('audit_log', {
  seq: bigint('seq', { mode: 'number' })
    .primaryKey()
    .default(sql`NULL`),
  id: uuid('id')
    .notNull()
    .default(sql`app.uuid_v7()`),
  occurredAt: timestamp('occurred_at', { withTimezone: true })
    .notNull()
    .default(sql`NULL`),
  actorId: uuid('actor_id'),
  actorType: text('actor_type', { enum: ['USER', 'SYSTEM', 'ANONYMOUS'] })
    .notNull()
    .default('USER'),
  action: text('action').notNull(),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  outcome: text('outcome', { enum: ['SUCCESS', 'FAILURE', 'DENIED'] })
    .notNull()
    .default('SUCCESS'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  requestId: text('request_id'),
  ipHash: text('ip_hash'),
  prevHash: text('prev_hash')
    .notNull()
    .default(sql`NULL`),
  hash: text('hash')
    .notNull()
    .default(sql`NULL`),
});

export const shipCursor = audit.table('ship_cursor', {
  id: smallint('id').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
  lastHash: text('last_hash'),
  lastObjectKey: text('last_object_key'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const securityAlert = audit.table('security_alert', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  kind: text('kind').notNull(),
  severity: text('severity', { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }).notNull(),
  subjectUserId: uuid('subject_user_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: uuid('acknowledged_by'),
});
