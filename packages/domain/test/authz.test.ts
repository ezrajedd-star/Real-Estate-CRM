import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
  canAccess,
  checkDecision,
  isPermission,
  isStaffRole,
  permissionsOf,
  roleHasPermission,
  type ApprovalState,
  type Permission,
  type RoleGrant,
} from '../src/index.js';

const PII_REVEALS: Permission[] = [
  'pii.reveal.tin',
  'pii.reveal.gov_id',
  'pii.reveal.bank',
  'pii.reveal.contact',
];

describe('role catalogue', () => {
  it('only references known permissions', () => {
    for (const role of STAFF_ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
    }
  });

  // One row per role: what it must NOT be able to do (brief §7.1).
  it.each<[string, Permission[]]>([
    [
      'SUPER_ADMIN',
      [
        ...PII_REVEALS,
        'company.read',
        'kyc.read',
        'audit.read',
        'config.approve',
        'user.approve_role_change',
      ],
    ],
    ['EXECUTIVE', [...PII_REVEALS, 'company.write', 'config.propose', 'audit.read']],
    [
      'LEASING_HEAD',
      ['pii.reveal.bank', 'pii.reveal.gov_id', 'config.approve', 'audit.read', 'break_glass.use'],
    ],
    [
      'LEASING_MANAGER',
      ['pii.reveal.bank', 'pii.reveal.gov_id', 'config.approve', 'export.approve', 'audit.read'],
    ],
    [
      'LEASING_OFFICER',
      [
        'pii.reveal.tin',
        'pii.reveal.bank',
        'kyc.read',
        'company.write',
        'config.read',
        'import.run',
      ],
    ],
    [
      'BILLING_OFFICER',
      ['pii.reveal.tin', 'pii.reveal.bank', 'kyc.read', 'company.write', 'config.approve'],
    ],
    ['PROPERTY_OFFICER', [...PII_REVEALS, 'kyc.read', 'config.read', 'document.read_sensitive']],
    ['FINANCE', ['pii.reveal.gov_id', 'user.approve_role_change', 'audit.read', 'break_glass.use']],
    ['COMPLIANCE_DPO', ['pii.reveal.bank', 'company.write', 'config.propose', 'break_glass.use']],
    [
      'INTERNAL_AUDITOR',
      [...PII_REVEALS, 'company.write', 'kyc.write', 'export.approve', 'config.propose'],
    ],
  ])('%s cannot %j', (role, denied) => {
    if (!isStaffRole(role)) throw new Error(role);
    for (const p of denied) expect(roleHasPermission(role, p), `${role} → ${p}`).toBe(false);
  });

  it('guards', () => {
    expect(isStaffRole('FINANCE')).toBe(true);
    expect(isStaffRole('ROOT')).toBe(false);
    expect(isPermission('audit.read')).toBe(true);
    expect(isPermission('audit.delete')).toBe(false);
  });
});

describe('canAccess (RBAC + ABAC scopes)', () => {
  const propA = '018f0000-0000-7000-8000-00000000000a';
  const propB = '018f0000-0000-7000-8000-00000000000b';
  const coX = '018f0000-0000-7000-8000-0000000000c1';
  const coY = '018f0000-0000-7000-8000-0000000000c2';

  const manager: RoleGrant[] = [{ role: 'LEASING_MANAGER', scopeType: 'PROPERTY', scopeId: propA }];
  const officer: RoleGrant[] = [{ role: 'LEASING_OFFICER', scopeType: 'COMPANY', scopeId: coX }];
  const head: RoleGrant[] = [{ role: 'LEASING_HEAD', scopeType: 'GLOBAL', scopeId: null }];

  it.each([
    ['manager, own property', manager, { propertyIds: [propA] }, true],
    ['manager, other property', manager, { propertyIds: [propB] }, false],
    ['manager, company with no property link', manager, { companyId: coX }, false],
    ['officer, assigned company', officer, { companyId: coX }, true],
    ['officer, other company', officer, { companyId: coY }, false],
    ['head, anything', head, { propertyIds: [propB] }, true],
  ] as const)('%s → %s', (_label, grants, resource, expected) => {
    expect(canAccess(grants, 'company.read', resource)).toBe(expected);
  });

  it('a permission the role lacks is never granted by scope', () => {
    expect(canAccess(officer, 'pii.reveal.tin', { companyId: coX })).toBe(false);
  });

  it('without a resource checks holding the permission anywhere', () => {
    expect(canAccess(manager, 'import.run')).toBe(true);
    expect(canAccess(officer, 'import.run')).toBe(false);
  });

  it('collects permissions from all grants', () => {
    const perms = permissionsOf([
      ...officer,
      { role: 'BILLING_OFFICER', scopeType: 'GLOBAL', scopeId: null },
    ]);
    expect(perms.has('contact.write')).toBe(true);
    expect(perms.has('config.read')).toBe(true);
    expect(perms.has('config.approve')).toBe(false);
  });
});

describe('maker–checker', () => {
  const base: ApprovalState = {
    type: 'CONFIG_CHANGE',
    makerId: 'maker',
    status: 'PENDING',
    decisions: [],
  };
  const approver = new Set<Permission>(['config.approve']);

  it.each([
    ['maker approves own item', base, 'maker', approver, { ok: false, reason: 'SELF_APPROVAL' }],
    [
      'checker lacks permission',
      base,
      'checker',
      new Set<Permission>(),
      { ok: false, reason: 'MISSING_PERMISSION' },
    ],
    [
      'already approved',
      { ...base, status: 'APPROVED' as const },
      'checker',
      approver,
      { ok: false, reason: 'NOT_PENDING' },
    ],
    [
      'same checker twice',
      {
        ...base,
        decisions: [{ stepIndex: 0, deciderId: 'checker', decision: 'APPROVE' as const }],
      },
      'checker',
      approver,
      { ok: false, reason: 'ALREADY_DECIDED' },
    ],
    [
      'valid approval',
      base,
      'checker',
      approver,
      { ok: true, stepIndex: 0, resultingStatus: 'APPROVED' },
    ],
  ] as const)('%s', (_l, state, decider, perms, expected) => {
    expect(checkDecision(state, decider, perms, 'APPROVE')).toEqual(expected);
  });

  it('rejection ends the request', () => {
    expect(checkDecision(base, 'checker', approver, 'REJECT')).toEqual({
      ok: true,
      stepIndex: 0,
      resultingStatus: 'REJECTED',
    });
  });

  it('no step beyond the last', () => {
    const done: ApprovalState = {
      ...base,
      decisions: [{ stepIndex: 0, deciderId: 'x', decision: 'APPROVE' }],
    };
    expect(checkDecision(done, 'checker', approver, 'APPROVE')).toEqual({
      ok: false,
      reason: 'MISSING_PERMISSION',
    });
  });
});
