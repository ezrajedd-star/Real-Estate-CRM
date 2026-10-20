'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { SessionDto } from '@crm/contracts';
import { Badge, Button, Card, PageHeader, Table, Td, formatDateTime } from '@crm/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';

type Session = z.infer<typeof SessionDto>;

export default function AccountPage() {
  const me = useMe();
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<Session[]>('/auth/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  return (
    <>
      <PageHeader title="My account" description={me.email} />
      <Card title="Roles">
        <ul className="space-y-1 text-sm">
          {me.grants.map((g) => (
            <li key={g.id}>
              <Badge tone="blue">{g.role}</Badge>{' '}
              <span className="text-slate-600">
                {g.scopeType === 'GLOBAL'
                  ? 'all properties'
                  : `${g.scopeType.toLowerCase()} ${g.scopeId}`}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Active sessions" className="mt-4">
        <Table head={['Device', 'Signed in', 'Last active', 'Expires', '']}>
          {sessions.data?.map((s) => (
            <tr key={s.id}>
              <Td className="max-w-xs truncate">{s.userAgent ?? 'Unknown device'}</Td>
              <Td>{formatDateTime(s.createdAt)}</Td>
              <Td>{formatDateTime(s.lastSeenAt)}</Td>
              <Td>{formatDateTime(s.absoluteExpiresAt)}</Td>
              <Td>
                {s.current ? (
                  <Badge tone="green">this device</Badge>
                ) : (
                  <Button variant="secondary" onClick={() => revoke.mutate(s.id)}>
                    Sign out
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
