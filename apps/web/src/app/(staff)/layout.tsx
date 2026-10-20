'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Permission } from '@crm/domain';
import { Alert, Button, cx, formatDateTime } from '@crm/ui';
import { api } from '@/lib/api';
import { AuthGate, useMe } from '@/lib/auth';

const NAV: Array<{ href: string; label: string; perm?: Permission }> = [
  { href: '/', label: 'Home' },
  { href: '/companies', label: 'Companies', perm: 'company.read' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/imports', label: 'Imports', perm: 'import.run' },
  { href: '/config', label: 'Rates & config', perm: 'config.read' },
  { href: '/users', label: 'Users', perm: 'user.read' },
  { href: '/audit', label: 'Audit log', perm: 'audit.read' },
  { href: '/account', label: 'My account' },
];

function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const path = usePathname();
  const logout = async () => {
    const res = await api<{ endSessionUrl: string | null }>('/auth/logout', { method: 'POST' });
    window.location.assign(res.endSessionUrl ?? '/login?signedOut=1');
  };
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-slate-200 bg-white">
        <div className="px-4 py-4 text-sm font-semibold text-brand-900">Leasing CRM</div>
        <nav aria-label="Main" className="space-y-0.5 px-2">
          {NAV.filter((n) => !n.perm || me.permissions.includes(n.perm)).map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={path === n.href ? 'page' : undefined}
              className={cx(
                'block rounded-md px-3 py-2 text-sm',
                (n.href === '/' ? path === '/' : path.startsWith(n.href))
                  ? 'bg-brand-50 font-medium text-brand-700'
                  : 'text-slate-700 hover:bg-slate-100',
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-4 border-b border-slate-200 bg-white px-6 py-3 text-sm">
          <span className="text-slate-600" data-testid="current-user">
            {me.displayName} ·{' '}
            {me.grants.map((g) => g.role.replace(/_/g, ' ').toLowerCase()).join(', ') || 'no roles'}
          </span>
          <Button variant="secondary" onClick={logout}>
            Sign out
          </Button>
        </header>
        {me.breakGlassUntil && (
          <div className="px-6 pt-4">
            <Alert tone="amber">
              Break-glass access is active until {formatDateTime(me.breakGlassUntil)}. Every action
              is logged and security has been alerted.
            </Alert>
          </div>
        )}
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

export default function StaffLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <Shell>{children}</Shell>
    </AuthGate>
  );
}
