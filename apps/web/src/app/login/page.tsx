import { Alert } from '@crm/ui';

const ERRORS: Record<string, string> = {
  MFA_REQUIRED:
    'Multi-factor authentication is required. Set up a passkey or authenticator app, then try again.',
  ACCOUNT_INACTIVE: 'Your account is not active. Contact your administrator.',
  LOGIN_EXPIRED: 'The sign-in attempt expired. Please try again.',
  STATE_MISMATCH: 'The sign-in attempt could not be verified. Please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  const returnTo = q.returnTo && /^\/(?![/\\])/.test(q.returnTo) ? q.returnTo : '/';
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Leasing CRM</h1>
          <p className="mt-1 text-sm text-slate-600">
            Staff sign-in with your company account. A passkey or authenticator code is required.
          </p>
        </div>
        {q.error && <Alert>{ERRORS[q.error] ?? 'Sign-in failed. Please try again.'}</Alert>}
        {q.signedOut && <Alert tone="green">You have been signed out.</Alert>}
        <a
          href={`/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
          className="flex w-full items-center justify-center rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Sign in
        </a>
        <p className="text-xs text-slate-500">
          Personal data in this system is protected under the Data Privacy Act of 2012. Access is
          logged.
        </p>
      </div>
    </main>
  );
}
