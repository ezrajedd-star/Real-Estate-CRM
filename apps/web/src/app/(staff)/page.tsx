'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader } from '@crm/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';

export default function HomePage() {
  const me = useMe();
  const approvals = useQuery({
    queryKey: ['approvals', 'PENDING'],
    queryFn: () => api<Array<{ id: string; canDecide: boolean }>>('/approvals?status=PENDING'),
  });
  const toDecide = approvals.data?.filter((a) => a.canDecide).length ?? 0;
  return (
    <>
      <PageHeader
        title={`Welcome, ${me.displayName}`}
        description="Phase 1: foundation — contacts, approvals, configuration and imports."
      />
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Approvals waiting for you">
          <p className="text-3xl font-semibold">{approvals.isPending ? '…' : toDecide}</p>
          <Link className="text-sm text-brand-600 hover:underline" href="/approvals">
            Open inbox
          </Link>
        </Card>
        <Card title="Your session">
          <p className="text-sm text-slate-600">
            Signed in with: {me.session.amr.join(', ') || 'single sign-on'}
          </p>
          <Link className="text-sm text-brand-600 hover:underline" href="/account">
            Manage sessions
          </Link>
        </Card>
      </div>
    </>
  );
}
