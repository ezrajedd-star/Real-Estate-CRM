import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { type Tx, accessReview, appUser, breakGlassGrant, roleAssignment } from '@crm/db';
import { type Clock, type ScopeType, type StaffRole, isStaffRole } from '@crm/domain';
import type { Logger } from '@crm/platform';
import type { AuthedCtx } from '../../common/context.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../common/errors.js';
import { CLOCK, LOGGER } from '../../common/tokens.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { ApprovalsService } from '../approvals/index.js';
import { SessionService } from '../auth/index.js';
import { KeycloakAdminClient } from './keycloak-admin.js';

type RoleChangePayload =
  | {
      action: 'GRANT';
      userId: string;
      role: StaffRole;
      scopeType: ScopeType;
      scopeId: string | null;
      justification: string;
    }
  | { action: 'REVOKE'; userId: string; assignmentId: string; justification: string };

@Injectable()
export class IdentityService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly sessions: SessionService,
    private readonly keycloak: KeycloakAdminClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  onModuleInit(): void {
    this.approvals.register('ROLE_CHANGE', {
      apply: (tx, ctx, req) => this.applyRoleChange(tx, ctx, req.payload as RoleChangePayload),
    });
  }

  async listUsers(ctx: AuthedCtx) {
    return this.db.run(ctx, async (tx) => {
      const users = await tx
        .select()
        .from(appUser)
        .where(eq(appUser.isSystem, false))
        .orderBy(asc(appUser.displayName));
      const grants = await tx.select().from(roleAssignment).where(isNull(roleAssignment.revokedAt));
      return users.map((u) =>
        this.userDto(
          u,
          grants.filter((g) => g.userId === u.id),
        ),
      );
    });
  }

  async getUser(ctx: AuthedCtx, id: string) {
    return this.db.run(ctx, async (tx) => {
      const [u] = await tx
        .select()
        .from(appUser)
        .where(and(eq(appUser.id, id), eq(appUser.isSystem, false)));
      if (!u) throw NotFound('User');
      const grants = await tx
        .select()
        .from(roleAssignment)
        .where(and(eq(roleAssignment.userId, id), isNull(roleAssignment.revokedAt)));
      return this.userDto(u, grants);
    });
  }

  /** Maker step: a role change is only a request until someone else approves it. */
  async proposeRoleChange(
    ctx: AuthedCtx,
    userId: string,
    change:
      | {
          action: 'GRANT';
          role: StaffRole;
          scopeType: ScopeType;
          scopeId: string | null;
          justification: string;
        }
      | { action: 'REVOKE'; assignmentId: string; justification: string },
  ) {
    if (userId === ctx.user.id) throw Forbidden('You cannot request role changes for yourself');
    return this.db.run(ctx, async (tx) => {
      const [u] = await tx.select().from(appUser).where(eq(appUser.id, userId));
      if (!u || u.isSystem) throw NotFound('User');
      if (u.status !== 'ACTIVE') throw Conflict('USER_INACTIVE', 'This user is not active');
      let summary: string;
      if (change.action === 'GRANT') {
        summary = `Grant ${change.role} (${change.scopeType}${change.scopeId ? ` ${change.scopeId}` : ''}) to ${u.displayName}`;
      } else {
        const [a] = await tx
          .select()
          .from(roleAssignment)
          .where(
            and(
              eq(roleAssignment.id, change.assignmentId),
              eq(roleAssignment.userId, userId),
              isNull(roleAssignment.revokedAt),
            ),
          );
        if (!a) throw NotFound('Role assignment');
        summary = `Revoke ${a.role} (${a.scopeType}) from ${u.displayName}`;
      }
      const payload: RoleChangePayload = { ...change, userId };
      return this.approvals.create(tx, ctx, {
        type: 'ROLE_CHANGE',
        summary,
        payload,
        subjectType: 'user',
        subjectId: userId,
      });
    });
  }

  /** Checker step, called by the approvals engine inside the approving transaction. */
  private async applyRoleChange(tx: Tx, ctx: AuthedCtx, p: RoleChangePayload): Promise<void> {
    if (p.userId === ctx.user.id) throw Forbidden('You cannot approve a role change for yourself');
    if (p.action === 'GRANT') {
      if (!isStaffRole(p.role)) throw BadRequest('INVALID_ROLE', 'Unknown role');
      await tx
        .insert(roleAssignment)
        .values({
          userId: p.userId,
          role: p.role,
          scopeType: p.scopeType,
          scopeId: p.scopeId,
          grantedBy: ctx.user.id,
        })
        .onConflictDoNothing();
    } else {
      await tx
        .update(roleAssignment)
        .set({ revokedAt: this.clock.now(), revokedBy: ctx.user.id })
        .where(and(eq(roleAssignment.id, p.assignmentId), isNull(roleAssignment.revokedAt)));
    }
    await this.audit.record(tx, {
      action: `identity.role_${p.action === 'GRANT' ? 'granted' : 'revoked'}`,
      subjectType: 'user',
      subjectId: p.userId,
      details:
        p.action === 'GRANT'
          ? { role: p.role, scopeType: p.scopeType, scopeId: p.scopeId }
          : { assignmentId: p.assignmentId },
    });
  }

  /** Leaver process: blocks access everywhere immediately (brief §7.4). */
  async offboard(ctx: AuthedCtx, userId: string, reason: string) {
    if (userId === ctx.user.id) throw Forbidden('You cannot offboard yourself');
    const user = await this.db.run(ctx, async (tx) => {
      const [u] = await tx.select().from(appUser).where(eq(appUser.id, userId));
      if (!u || u.isSystem) throw NotFound('User');
      await tx
        .update(appUser)
        .set({ status: 'LEFT', leftAt: this.clock.now() })
        .where(eq(appUser.id, userId));
      await this.audit.record(tx, {
        action: 'identity.offboarded',
        subjectType: 'user',
        subjectId: userId,
        details: { reason },
      });
      return u;
    });
    const revoked = await this.sessions.destroyAllForUser(ctx, userId, 'OFFBOARDED');
    let idpDisabled = false;
    try {
      idpDisabled = await this.keycloak.disableAndLogout(user.keycloakSub);
    } catch (err) {
      this.log.error({ err }, 'keycloak disable failed during offboarding');
      await this.audit.alertStandalone(ctx, {
        kind: 'OFFBOARD_IDP_FAILED',
        severity: 'HIGH',
        subjectUserId: userId,
      });
    }
    return { sessionsRevoked: revoked, idpDisabled };
  }

  /** Emergency access for Super Admin: time-boxed, reasoned, read-only, alerting. */
  async startBreakGlass(ctx: AuthedCtx, reason: string, minutes: number) {
    return this.db.run(ctx, async (tx) => {
      const now = this.clock.now();
      const [grant] = await tx
        .insert(breakGlassGrant)
        .values({
          userId: ctx.user.id,
          reason,
          startedAt: now,
          expiresAt: new Date(now.getTime() + minutes * 60_000),
        })
        .returning();
      await this.audit.record(tx, {
        action: 'security.break_glass_started',
        subjectType: 'break_glass',
        subjectId: grant!.id,
        details: { minutes },
      });
      await this.audit.alert(tx, {
        kind: 'BREAK_GLASS',
        severity: 'CRITICAL',
        subjectUserId: ctx.user.id,
        details: { grantId: grant!.id, minutes },
      });
      return { id: grant!.id, expiresAt: grant!.expiresAt.toISOString() };
    });
  }

  async endBreakGlass(ctx: AuthedCtx) {
    return this.db.run(ctx, async (tx) => {
      const ended = await tx
        .update(breakGlassGrant)
        .set({ endedAt: this.clock.now() })
        .where(and(eq(breakGlassGrant.userId, ctx.user.id), isNull(breakGlassGrant.endedAt)))
        .returning({ id: breakGlassGrant.id });
      for (const g of ended) {
        await this.audit.record(tx, {
          action: 'security.break_glass_ended',
          subjectType: 'break_glass',
          subjectId: g.id,
        });
      }
    });
  }

  /** Quarterly access review: a snapshot of who holds which role where. */
  async generateAccessReview(ctx: AuthedCtx, periodLabel: string) {
    return this.db.run(ctx, async (tx) => {
      const users = await tx.select().from(appUser).where(eq(appUser.isSystem, false));
      const grants = await tx.select().from(roleAssignment).where(isNull(roleAssignment.revokedAt));
      const snapshot = users.map((u) => ({
        userId: u.id,
        displayName: u.displayName,
        status: u.status,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        grants: grants
          .filter((g) => g.userId === u.id)
          .map((g) => ({
            role: g.role,
            scopeType: g.scopeType,
            scopeId: g.scopeId,
            grantedAt: g.grantedAt.toISOString(),
          })),
        flags: [
          ...(u.status !== 'ACTIVE' && grants.some((g) => g.userId === u.id)
            ? ['INACTIVE_WITH_ROLES']
            : []),
          ...(u.lastLoginAt && this.clock.now().getTime() - u.lastLoginAt.getTime() > 90 * 864e5
            ? ['NO_LOGIN_90_DAYS']
            : []),
        ],
      }));
      const [row] = await tx
        .insert(accessReview)
        .values({ periodLabel, generatedBy: ctx.user.id, snapshot })
        .returning();
      await this.audit.record(tx, {
        action: 'identity.access_review_generated',
        subjectType: 'access_review',
        subjectId: row!.id,
      });
      return {
        id: row!.id,
        periodLabel,
        generatedAt: row!.generatedAt.toISOString(),
        users: snapshot,
      };
    });
  }

  async listAccessReviews(ctx: AuthedCtx) {
    return this.db.run(ctx, (tx) =>
      tx
        .select({
          id: accessReview.id,
          periodLabel: accessReview.periodLabel,
          generatedAt: accessReview.generatedAt,
          generatedBy: accessReview.generatedBy,
        })
        .from(accessReview),
    );
  }

  private userDto(
    u: typeof appUser.$inferSelect,
    grants: Array<typeof roleAssignment.$inferSelect>,
  ) {
    return {
      id: u.id,
      displayName: u.displayName,
      email: u.email,
      status: u.status,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      grants: grants.map((g) => ({
        id: g.id,
        role: g.role,
        scopeType: g.scopeType,
        scopeId: g.scopeId,
        grantedAt: g.grantedAt.toISOString(),
      })),
    };
  }
}
