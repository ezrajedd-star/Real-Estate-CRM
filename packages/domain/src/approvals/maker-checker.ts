import type { Permission } from '../authz/catalogue.js';

/**
 * Maker–checker rules (brief §7.3). Each approval type lists its steps; each step names the
 * permission a checker needs. The preparer can never approve their own item, and one person
 * cannot approve two steps of the same request.
 */
export const APPROVAL_TYPES = {
  ROLE_CHANGE: { steps: ['user.approve_role_change'] },
  CONFIG_CHANGE: { steps: ['config.approve'] },
  BULK_EXPORT: { steps: ['export.approve'] },
} as const satisfies Record<string, { steps: readonly Permission[] }>;
export type ApprovalType = keyof typeof APPROVAL_TYPES;

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface ApprovalDecisionRecord {
  stepIndex: number;
  deciderId: string;
  decision: 'APPROVE' | 'REJECT';
}

export interface ApprovalState {
  type: ApprovalType;
  makerId: string;
  status: ApprovalStatus;
  decisions: readonly ApprovalDecisionRecord[];
}

export type DecisionCheck =
  | { ok: true; stepIndex: number; resultingStatus: ApprovalStatus }
  | {
      ok: false;
      reason: 'NOT_PENDING' | 'SELF_APPROVAL' | 'ALREADY_DECIDED' | 'MISSING_PERMISSION';
    };

export function checkDecision(
  state: ApprovalState,
  deciderId: string,
  deciderPermissions: ReadonlySet<Permission>,
  decision: 'APPROVE' | 'REJECT',
): DecisionCheck {
  if (state.status !== 'PENDING') return { ok: false, reason: 'NOT_PENDING' };
  if (deciderId === state.makerId) return { ok: false, reason: 'SELF_APPROVAL' };
  if (state.decisions.some((d) => d.deciderId === deciderId))
    return { ok: false, reason: 'ALREADY_DECIDED' };

  const steps = APPROVAL_TYPES[state.type].steps;
  const stepIndex = state.decisions.length;
  const required = steps[stepIndex];
  if (!required || !deciderPermissions.has(required))
    return { ok: false, reason: 'MISSING_PERMISSION' };

  const resultingStatus: ApprovalStatus =
    decision === 'REJECT' ? 'REJECTED' : stepIndex === steps.length - 1 ? 'APPROVED' : 'PENDING';
  return { ok: true, stepIndex, resultingStatus };
}
