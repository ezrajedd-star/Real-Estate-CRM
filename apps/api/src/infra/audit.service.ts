import { Injectable } from '@nestjs/common';
import { type Tx, auditLog, securityAlert } from '@crm/db';
import { redact } from '@crm/platform';
import type { Ctx } from '../common/context.js';
import { DbService } from './db.service.js';

export interface AuditEntry {
  /** dot.separated verb, e.g. `pii.reveal`, `auth.login`, `document.download_url` */
  action: string;
  subjectType?: string;
  subjectId?: string;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  /** Context only — never clear-text PII. Redacted again here as a safety net. */
  details?: Record<string, unknown>;
}

export interface AlertEntry {
  kind: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  subjectUserId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Application-level audit events (logins, reveals, downloads, exports, approvals…). Row
 * changes on sensitive tables are additionally captured by database triggers. Actor,
 * timestamp, request id and IP hash are filled in by the database from the request context.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /** Record inside the caller's transaction, so the event commits or rolls back with the action. */
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      action: entry.action,
      subjectType: entry.subjectType ?? null,
      subjectId: entry.subjectId ?? null,
      outcome: entry.outcome ?? 'SUCCESS',
      details: (redact(entry.details ?? {}) as Record<string, unknown>) ?? {},
    });
  }

  /** Record in its own transaction — for denials and failures whose main transaction rolled back. */
  async recordStandalone(ctx: Ctx, entry: AuditEntry): Promise<void> {
    await this.db.run(ctx, (tx) => this.record(tx, entry));
  }

  async alert(tx: Tx, entry: AlertEntry): Promise<void> {
    await tx.insert(securityAlert).values({
      kind: entry.kind,
      severity: entry.severity,
      subjectUserId: entry.subjectUserId ?? null,
      details: (redact(entry.details ?? {}) as Record<string, unknown>) ?? {},
    });
  }

  async alertStandalone(ctx: Ctx, entry: AlertEntry): Promise<void> {
    await this.db.run(ctx, (tx) => this.alert(tx, entry));
  }
}
