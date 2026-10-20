/**
 * Browser API client. Same-origin only (`/api/v1` is proxied to the API), cookies are
 * httpOnly and never touched here; state-changing calls carry the CSRF token from /auth/me.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Where the browser goes to sign in again, optionally with fresh MFA (step-up). */
export function loginUrl(opts: { returnTo?: string; stepUp?: boolean } = {}): string {
  const returnTo =
    opts.returnTo ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const q = new URLSearchParams({ returnTo });
  if (opts.stepUp) q.set('stepUp', '1');
  return `/api/v1/auth/login?${q}`;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(method !== 'GET' && csrfToken && { 'x-csrf-token': csrfToken }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = data?.error ?? {};
    const e = new ApiError(
      res.status,
      err.code ?? 'ERROR',
      err.message ?? res.statusText,
      err.details,
      err.requestId,
    );
    if (e.code === 'STEP_UP_REQUIRED') {
      window.location.assign(loginUrl({ stepUp: true }));
    } else if (res.status === 401 && path !== '/auth/me') {
      window.location.assign(loginUrl());
    }
    throw e;
  }
  return data as T;
}

/** Downloads a non-JSON response (e.g. CSV export) as a file. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...(csrfToken && { 'x-csrf-token': csrfToken }) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data?.error?.code === 'STEP_UP_REQUIRED')
      window.location.assign(loginUrl({ stepUp: true }));
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'ERROR',
      data?.error?.message ?? 'Download failed',
    );
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}
