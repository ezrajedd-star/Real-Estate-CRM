import { eq } from 'drizzle-orm';
import { type Tx, company, companyProperty } from '@crm/db';
import { type Permission, canAccess } from '@crm/domain';
import type { AuthedCtx } from '../../common/context.js';
import { NotFound } from '../../common/errors.js';

/**
 * Application-layer object authorization for companies (the first of two layers — RLS is
 * the second). Out-of-scope and non-existent ids are indistinguishable: both are 404.
 */
export async function assertCompanyAccess(
  tx: Tx,
  ctx: AuthedCtx,
  companyId: string,
  permission: Permission,
) {
  const [row] = await tx.select().from(company).where(eq(company.id, companyId));
  if (!row) throw NotFound('Company');
  const links = await tx
    .select({ propertyId: companyProperty.propertyId })
    .from(companyProperty)
    .where(eq(companyProperty.companyId, companyId));
  const propertyIds = links.map((l) => l.propertyId);
  const allowed =
    canAccess(ctx.user.grants, permission, { companyId, propertyIds }) ||
    (permission.endsWith('.read') && !!ctx.user.breakGlassUntil);
  if (!allowed) throw NotFound('Company');
  return { company: row, propertyIds };
}

export function hasGlobal(ctx: AuthedCtx, permission: Permission): boolean {
  return ctx.user.grants.some((g) => g.scopeType === 'GLOBAL' && canAccess([g], permission));
}
