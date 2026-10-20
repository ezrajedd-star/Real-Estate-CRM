'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import type { ApprovalDto } from '@crm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  formatDateTime,
} from '@crm/ui';
import { ApiError, api } from '@/lib/api';
import { useMe } from '@/lib/auth';

type Approval = z.infer<typeof ApprovalDto>;

export default function ApprovalsPage() {
  const me = useMe();
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | ''>('PENDING');
  const [deciding, setDeciding] = useState<Approval | null>(null);
  const list = useQuery({
    queryKey: ['approvals', status],
    queryFn: () => api<Approval[]>(`/approvals${status ? `?status=${status}` : ''}`),
  });
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Maker–checker queue. You can never approve a request you made."
      />
      <Card
        actions={
          <Select
            aria-label="Status filter"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="w-40"
          >
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="">All</option>
          </Select>
        }
      >
        <Table
          head={['Requested', 'Type', 'Summary', 'Status', '']}
          empty={list.data?.length === 0 ? 'Nothing here.' : undefined}
        >
          {list.data?.map((a) => (
            <tr key={a.id}>
              <Td>{formatDateTime(a.createdAt)}</Td>
              <Td>{a.type.replace('_', ' ')}</Td>
              <Td className="max-w-md truncate whitespace-normal">
                {a.summary}
                {a.makerId === me.id && (
                  <span className="ml-2 text-xs text-slate-500">(yours)</span>
                )}
              </Td>
              <Td>
                <Badge
                  tone={
                    a.status === 'APPROVED' ? 'green' : a.status === 'REJECTED' ? 'red' : 'amber'
                  }
                >
                  {a.status}
                </Badge>
              </Td>
              <Td>{a.canDecide && <Button onClick={() => setDeciding(a)}>Review</Button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      {deciding && <Decide approval={deciding} onClose={() => setDeciding(null)} />}
    </>
  );
}

function Decide({ approval, onClose }: { approval: Approval; onClose: () => void }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api<Approval>(`/approvals/${approval.id}/decision`, {
        method: 'POST',
        body: { decision, ...(comment && { comment }) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Review request">
      <div className="space-y-4">
        <p className="text-sm">{approval.summary}</p>
        {decide.error && (
          <Alert>{decide.error instanceof ApiError ? decide.error.message : 'Failed'}</Alert>
        )}
        <Field label="Comment" hint="Required when rejecting">
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            variant="danger"
            disabled={decide.isPending || !comment.trim()}
            onClick={() => decide.mutate('REJECT')}
          >
            Reject
          </Button>
          <Button disabled={decide.isPending} onClick={() => decide.mutate('APPROVE')}>
            Approve
          </Button>
        </div>
      </div>
    </Modal>
  );
}
