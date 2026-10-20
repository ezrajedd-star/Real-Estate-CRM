'use client';

import { useState } from 'react';
import { Alert, Button, Field, Modal, Textarea } from '@crm/ui';
import { ApiError, api } from '@/lib/api';

/**
 * Shows a masked value with a "Reveal" action. Revealing requires a reason, which is stored
 * in the audit trail; the clear value is held only in component state and hidden again
 * after 60 seconds.
 */
export function RevealableValue({
  masked,
  endpoint,
  field,
  label,
  canReveal,
}: {
  masked: string | null;
  endpoint: string;
  field: 'tin' | 'gov_id' | 'email' | 'phone' | 'bank_account';
  label: string;
  canReveal: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!masked) return <span className="text-slate-400">—</span>;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ value: string | null }>(endpoint, {
        method: 'POST',
        body: { field, reason },
      });
      setValue(res.value);
      setOpen(false);
      setReason('');
      setTimeout(() => setValue(null), 60_000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reveal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono" data-testid={`${field}-value`}>
        {value ?? masked}
      </span>
      {canReveal && !value && (
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpen(true)}>
          Reveal
        </Button>
      )}
      {value && (
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setValue(null)}>
          Hide
        </Button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={`Reveal ${label}`}>
        <div className="space-y-4">
          <Alert tone="amber">
            Revealing personal data is recorded with your name, the time and your reason.
          </Alert>
          <Field
            label="Reason"
            hint="At least 10 characters, e.g. 'Preparing lease contract'"
            error={error ?? undefined}
          >
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy || reason.trim().length < 10}>
              Reveal
            </Button>
          </div>
        </div>
      </Modal>
    </span>
  );
}
