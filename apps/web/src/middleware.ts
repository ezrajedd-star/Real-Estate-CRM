import { NextResponse, type NextRequest } from 'next/server';

/**
 * Strict, nonce-based Content-Security-Policy and security headers for every page
 * (brief §8.2). Scripts run only if they carry this request's nonce.
 */
export function middleware(req: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const dev = process.env.NODE_ENV !== 'production';
  // Browsers upload documents straight to object storage via presigned URLs (ADR-006).
  const uploadOrigin = process.env.UPLOAD_ORIGIN ? ` ${process.env.UPLOAD_ORIGIN}` : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${uploadOrigin}${dev ? ' ws:' : ''}`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.headers.set('cross-origin-opener-policy', 'same-origin');
  if (!dev)
    res.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  return res;
}

export const config = {
  // Pages only — /api/v1 is proxied to the API, which sets its own headers.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
};
