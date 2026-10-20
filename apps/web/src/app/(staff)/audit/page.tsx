'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, Input, PageHeader, Table, Td, formatDateTime } from '@crm/ui';
import { api } from '@/lib/api';

interface AuditRow {
  seq: number;
  occurredAt: string;
  actorId: string | null;
  actorType: string;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  hash: string;
}

export default function AuditPage() {
  const [action, setAction] = useState('');
  const rows = useQuery({
    queryKey: ['audit', action],
    queryFn: () =>
      api<AuditRow[]>(
        `/audit?limit=100${/^[a-z0-9_.]{2,}$/.test(action) ? `&action=${action}` : ''}`,
      ),
  });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only and hash-chained. Viewing this page is itself recorded."
      />
      <Card>
        <div className="mb-4 max-w-xs">
          <Input
            aria-label="Filter by action"
            placeholder="e.g. pii.reveal"
            value={action}
            onChange={(e) => setAction(e.target.value.trim())}
          />
        </div>
        <Table head={['#', 'When', 'Actor', 'Action', 'Subject', 'Outcome', 'Hash']}>
          {rows.data?.map((r) => (
            <tr key={r.seq}>
              <Td>{r.seq}</Td>
              <Td>{formatDateTime(r.occurredAt)}</Td>
              <Td className="font-mono text-xs">
                {r.actorType === 'USER' ? r.actorId?.slice(-8) : r.actorType}
              </Td>
              <Td className="font-mono text-xs">{r.action}</Td>
              <Td className="font-mono text-xs">
                {r.subjectType ? `${r.subjectType}:${r.subjectId?.slice(-8) ?? ''}` : '—'}
              </Td>
              <Td>
                <Badge tone={r.outcome === 'SUCCESS' ? 'green' : 'red'}>{r.outcome}</Badge>
              </Td>
              <Td className="font-mono text-xs">{r.hash.slice(0, 12)}…</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
