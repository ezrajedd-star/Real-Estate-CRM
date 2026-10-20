'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { z } from 'zod';
import type { MeDto } from '@crm/contracts';
import type { Permission } from '@crm/domain';
import { ApiError, api, loginUrl, setCsrfToken } from './api';

export type Me = z.infer<typeof MeDto>;

const MeContext = createContext<Me | null>(null);

/** Loads the session; unauthenticated visitors are sent to sign in. */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
    retry: false,
    refetchInterval: 60_000, // keeps idle-timeout state fresh
  });

  useEffect(() => {
    if (me.data) setCsrfToken(me.data.csrfToken);
    if (me.error instanceof ApiError && me.error.status === 401) window.location.assign(loginUrl());
  }, [me.data, me.error]);

  if (me.isPending || !me.data) {
    return <div className="flex h-screen items-center justify-center text-slate-500">Loading…</div>;
  }
  return <MeContext.Provider value={me.data}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside AuthGate');
  return me;
}

/** UI hint only — the API and the database enforce permissions independently. */
export function useCan(...perms: Permission[]): boolean {
  const me = useMe();
  return perms.every((p) => me.permissions.includes(p));
}
