/**
 * Single source of truth for staff roles and permissions (brief §7.1).
 *
 * Keycloak authenticates people; *authorization* (roles + scopes) lives in this system's
 * database so that changes go through maker–checker and are audited (ADR-003). The
 * migration runner syncs this catalogue into `app_role_permission`, which the Postgres RLS
 * policies read — so the app policy layer and RLS can never drift apart.
 */

export const STAFF_ROLES = [
  'SUPER_ADMIN',
  'EXECUTIVE',
  'LEASING_HEAD',
  'LEASING_MANAGER',
  'LEASING_OFFICER',
  'BILLING_OFFICER',
  'PROPERTY_OFFICER',
  'FINANCE',
  'COMPLIANCE_DPO',
  'INTERNAL_AUDITOR',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = [
  // contacts
  'company.read',
  'company.write',
  'contact.read',
  'contact.write',
  'kyc.read',
  'kyc.write',
  'consent.write',
  // field-level reveals (always need a reason; always audited)
  'pii.reveal.tin',
  'pii.reveal.gov_id',
  'pii.reveal.bank',
  'pii.reveal.contact', // unmasked email / phone
  // documents
  'document.upload',
  'document.read',
  'document.read_sensitive',
  // config / rates
  'config.read',
  'config.propose',
  'config.approve',
  // users and access
  'user.read',
  'user.propose_role_change',
  'user.approve_role_change',
  'user.revoke_sessions',
  'access_review.run',
  // approvals, audit, export, import
  'approval.read',
  'audit.read',
  'export.request',
  'export.approve',
  'import.run',
  // properties (scoping anchor in Phase 1)
  'property.read',
  'property.write',
  // system
  'system.integrations',
  'break_glass.use',
  'security.dashboard',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Where a role assignment applies. `GLOBAL` = all properties/tenants. */
export const SCOPE_TYPES = ['GLOBAL', 'PROPERTY', 'COMPANY'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

const READ_CONTACTS: Permission[] = ['company.read', 'contact.read', 'property.read'];

export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  // Separation of duties: IT admins run the system but see no tenant PII or financials.
  SUPER_ADMIN: [
    'config.read',
    'config.propose',
    'user.read',
    'user.propose_role_change',
    'user.revoke_sessions',
    'system.integrations',
    'break_glass.use',
    'property.read',
    'property.write',
  ],
  // Read-only; PII masked by default (no reveal permissions).
  EXECUTIVE: [...READ_CONTACTS, 'kyc.read', 'config.read', 'approval.read', 'document.read'],
  LEASING_HEAD: [
    ...READ_CONTACTS,
    'company.write',
    'contact.write',
    'kyc.read',
    'kyc.write',
    'consent.write',
    'pii.reveal.tin',
    'pii.reveal.contact',
    'document.upload',
    'document.read',
    'document.read_sensitive',
    'config.read',
    'approval.read',
    'export.request',
    'import.run',
    'user.read',
  ],
  LEASING_MANAGER: [
    ...READ_CONTACTS,
    'company.write',
    'contact.write',
    'kyc.read',
    'kyc.write',
    'consent.write',
    'pii.reveal.tin',
    'pii.reveal.contact',
    'document.upload',
    'document.read',
    'config.read',
    'approval.read',
    'import.run',
  ],
  LEASING_OFFICER: [
    ...READ_CONTACTS,
    'contact.write',
    'consent.write',
    'pii.reveal.contact',
    'document.upload',
    'document.read',
  ],
  BILLING_OFFICER: [...READ_CONTACTS, 'pii.reveal.contact', 'document.read', 'config.read'],
  // Operations only: no financial detail, no KYC.
  PROPERTY_OFFICER: [
    'company.read',
    'contact.read',
    'property.read',
    'property.write',
    'document.upload',
    'document.read',
  ],
  FINANCE: [
    ...READ_CONTACTS,
    'kyc.read',
    'pii.reveal.tin',
    'pii.reveal.bank',
    'pii.reveal.contact',
    'document.read',
    'document.read_sensitive',
    'config.read',
    'config.propose',
    'config.approve',
    'approval.read',
    'export.request',
    'export.approve',
    'import.run',
  ],
  COMPLIANCE_DPO: [
    ...READ_CONTACTS,
    'kyc.read',
    'kyc.write',
    'consent.write',
    'pii.reveal.tin',
    'pii.reveal.gov_id',
    'pii.reveal.contact',
    'document.read',
    'document.read_sensitive',
    'config.read',
    'config.approve',
    'audit.read',
    'approval.read',
    'export.approve',
    'user.read',
    'user.approve_role_change',
    'user.revoke_sessions',
    'access_review.run',
    'security.dashboard',
  ],
  // Read-only including audit logs; bulk PII export only via approval.
  INTERNAL_AUDITOR: [
    ...READ_CONTACTS,
    'kyc.read',
    'config.read',
    'approval.read',
    'audit.read',
    'user.read',
    'export.request',
    'document.read',
  ],
};

export function roleHasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(value);
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** An active role assignment as the policy layer sees it. */
export interface RoleGrant {
  role: StaffRole;
  scopeType: ScopeType;
  scopeId: string | null;
}

/** The object being accessed, described by the scopes it belongs to. */
export interface ResourceScope {
  propertyIds?: readonly string[];
  companyId?: string;
}

/**
 * Attribute-based check: does any grant give `permission` over `resource`?
 * With no resource, answers "does the user hold this permission anywhere?".
 */
export function canAccess(
  grants: readonly RoleGrant[],
  permission: Permission,
  resource?: ResourceScope,
): boolean {
  return grants.some((g) => {
    if (!roleHasPermission(g.role, permission)) return false;
    if (!resource || g.scopeType === 'GLOBAL') return true;
    if (g.scopeType === 'PROPERTY') return !!resource.propertyIds?.includes(g.scopeId ?? '');
    return g.scopeType === 'COMPANY' && resource.companyId === g.scopeId;
  });
}

export function permissionsOf(grants: readonly RoleGrant[]): Set<Permission> {
  return new Set(grants.flatMap((g) => ROLE_PERMISSIONS[g.role]));
}
