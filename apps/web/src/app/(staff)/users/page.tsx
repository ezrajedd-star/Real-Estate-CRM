'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import type { UserSummaryDto } from '@crm/contracts';
import { STAFF_ROLES } from '@crm/domain';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  formatDateTime,
} from '@crm/ui';
import { ApiError, api } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';

type User = z.infer<typeof UserSummaryDto>;

export default function UsersPage() {
  const me = useMe();
  const canPropose = useCan('user.propose_role_change');
  const [target, setTarget] = useState<User | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') });
  return (
    <>
      <PageHeader
        title="Users"
        description="Role changes are requests that a Compliance Officer must approve."
      />
      <Card>
        <Table head={['Name', 'Email', 'Status', 'Roles', 'Last login', '']}>
          {users.data?.map((u) => (
            <tr key={u.id}>
              <Td>{u.displayName}</Td>
              <Td>{u.email}</Td>
              <Td>
                <Badge tone={u.status === 'ACTIVE' ? 'green' : 'red'}>{u.status}</Badge>
              </Td>
              <Td className="whitespace-normal">
                {u.grants
                  .map(
                    (g) =>
                      `${g.role}${g.scopeType === 'GLOBAL' ? '' : ` (${g.scopeType.toLowerCase()})`}`,
                  )
                  .join(', ') || '—'}
              </Td>
              <Td>{formatDateTime(u.lastLoginAt)}</Td>
              <Td>
                {canPropose && u.id !== me.id && u.status === 'ACTIVE' && (
                  <Button variant="secondary" onClick={() => setTarget(u)}>
                    Request role change
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {target && <RoleChange user={target} onClose={() => setTarget(null)} />}
    </>
  );
}

function RoleChange({ user, onClose }: { user: User; onClose: () => void }) {
  const [role, setRole] = useState<string>('LEASING_OFFICER');
  const [scopeType, setScopeType] = useState<'GLOBAL' | 'PROPERTY' | 'COMPANY'>('PROPERTY');
  const [scopeId, setScopeId] = useState('');
  const [justification, setJustification] = useState('');
  const submit = useMutation({
    mutationFn: () =>
      api(`/users/${user.id}/role-changes`, {
        method: 'POST',
        body: {
          action: 'GRANT',
          role,
          scopeType,
          scopeId: scopeType === 'GLOBAL' ? null : scopeId,
          justification,
        },
      }),
    onSuccess: onClose,
  });
  return (
    <Modal open onClose={onClose} title={`Grant a role to ${user.displayName}`}>
      <div className="space-y-3">
        {submit.error && (
          <Alert>{submit.error instanceof ApiError ? submit.error.message : 'Failed'}</Alert>
        )}
        <Field label="Role">
          {(p) => (
            <Select {...p} value={role} onChange={(e) => setRole(e.target.value)}>
              {STAFF_ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Scope">
          {(p) => (
            <Select
              {...p}
              value={scopeType}
              onChange={(e) => setScopeType(e.target.value as typeof scopeType)}
            >
              <option value="GLOBAL">All properties</option>
              <option value="PROPERTY">One property</option>
              <option value="COMPANY">One tenant company</option>
            </Select>
          )}
        </Field>
        {scopeType !== 'GLOBAL' && (
          <Field label={scopeType === 'PROPERTY' ? 'Property id' : 'Company id'}>
            {(p) => <Input {...p} value={scopeId} onChange={(e) => setScopeId(e.target.value)} />}
          </Field>
        )}
        <Field label="Justification">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
            Submit for approval
          </Button>
        </div>
      </div>
    </Modal>
  );
}
