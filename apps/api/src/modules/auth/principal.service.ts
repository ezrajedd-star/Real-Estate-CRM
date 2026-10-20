import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { appUser, breakGlassGrant, roleAssignment } from '@crm/db';
import { type Clock, isStaffRole, permissionsOf } from '@crm/domain';
import type { AuthenticatedUser, Ctx, Grant } from '../../common/context.js';
import { CLOCK } from '../../common/tokens.js';
import { DbService } from '../../infra/db.service.js';

/**
 * Loads who the caller is — status, role grants and any active break-glass grant — fresh
 * from the database on every request, so a revoked role or a leaver is cut off immediately.
 */
@Injectable()
export class PrincipalService {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async load(
    userId: string,
    base: Pick<Ctx, 'requestId' | 'ipHash'>,
  ): Promise<AuthenticatedUser | null> {
    return this.db.runAs(userId, base, async (tx) => {
      const [user] = await tx.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
      if (!user || user.status !== 'ACTIVE' || user.isSystem) return null;

      const rows = await tx
        .select()
        .from(roleAssignment)
        .where(and(eq(roleAssignment.userId, userId), isNull(roleAssignment.revokedAt)));
      const grants: Grant[] = rows.flatMap((r) =>
        isStaffRole(r.role)
          ? [
              {
                id: r.id,
                role: r.role,
                scopeType: r.scopeType,
                scopeId: r.scopeId,
                grantedAt: r.grantedAt,
              },
            ]
          : [],
      );

      const [bg] = await tx
        .select({ expiresAt: breakGlassGrant.expiresAt })
        .from(breakGlassGrant)
        .where(
          and(
            eq(breakGlassGrant.userId, userId),
            isNull(breakGlassGrant.endedAt),
            gt(breakGlassGrant.expiresAt, this.clock.now()),
          ),
        )
        .limit(1);

      return {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        grants,
        permissions: permissionsOf(grants),
        breakGlassUntil: bg?.expiresAt ?? null,
      };
    });
  }
}
