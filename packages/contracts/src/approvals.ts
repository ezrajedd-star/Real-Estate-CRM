import { Text, Uuid, z } from './common.js';

export const ApprovalTypeSchema = z.enum(['ROLE_CHANGE', 'CONFIG_CHANGE', 'BULK_EXPORT']);
export const ApprovalStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

export const ApprovalDto = z
  .object({
    id: Uuid,
    type: ApprovalTypeSchema,
    summary: z.string(),
    subjectType: z.string().nullable(),
    subjectId: z.string().nullable(),
    makerId: Uuid,
    status: ApprovalStatusSchema,
    createdAt: z.string().datetime(),
    decidedAt: z.string().datetime().nullable(),
    appliedAt: z.string().datetime().nullable(),
    canDecide: z.boolean(),
    decisions: z.array(
      z.object({
        stepIndex: z.number().int(),
        deciderId: Uuid,
        decision: z.enum(['APPROVE', 'REJECT']),
        comment: z.string().nullable(),
        decidedAt: z.string().datetime(),
      }),
    ),
  })
  .openapi('Approval');

export const DecisionRequest = z
  .object({ decision: z.enum(['APPROVE', 'REJECT']), comment: Text(1000).optional() })
  .refine((v) => v.decision === 'APPROVE' || !!v.comment, {
    message: 'A rejection needs a comment',
    path: ['comment'],
  })
  .openapi('DecisionRequest');
