'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import type { FeatureFlagDto, TaxRateDto } from '@crm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageHeader,
  Table,
  Td,
  Textarea,
  formatDate,
  formatRate,
} from '@crm/ui';
import { ApiError, api } from '@/lib/api';
import { useCan } from '@/lib/auth';

type TaxRate = z.infer<typeof TaxRateDto>;
type Flag = z.infer<typeof FeatureFlagDto>;

export default function ConfigPage() {
  const canPropose = useCan('config.propose');
  const [proposing, setProposing] = useState(false);
  const rates = useQuery({
    queryKey: ['tax-rates'],
    queryFn: () => api<TaxRate[]>('/config/tax-rates'),
  });
  const flags = useQuery({
    queryKey: ['flags'],
    queryFn: () => api<Flag[]>('/config/feature-flags'),
  });
  return (
    <>
      <PageHeader
        title="Rates & configuration"
        description="Tax rates and thresholds have effective dates and change only through maker–checker approval."
        actions={
          canPropose && <Button onClick={() => setProposing(true)}>Propose rate change</Button>
        }
      />
      <Alert tone="amber">
        Rows marked “needs confirmation” are seed defaults that must be validated by the accountant
        before go-live.
      </Alert>
      <Card title="Tax rates" className="mt-4">
        <Table head={['Tax', 'Rate', 'Basis', 'Effective from', 'Effective to', '']}>
          {rates.data?.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono">{r.taxType}</Td>
              <Td>{r.rate ? formatRate(r.rate) : 'brackets'}</Td>
              <Td className="max-w-xs truncate">{r.basis}</Td>
              <Td>{formatDate(r.effectiveFrom)}</Td>
              <Td>{r.effectiveTo ? formatDate(r.effectiveTo) : 'open'}</Td>
              <Td>{r.needsConfirmation && <Badge tone="amber">needs confirmation</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Feature flags" className="mt-4">
        <Table head={['Flag', 'State', 'Description']}>
          {flags.data?.map((f) => (
            <tr key={f.key}>
              <Td className="font-mono">{f.key}</Td>
              <Td>{f.enabled ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</Td>
              <Td className="whitespace-normal">{f.description}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      {proposing && <ProposeRate onClose={() => setProposing(false)} />}
    </>
  );
}

function ProposeRate({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState({
    taxType: '',
    rate: '',
    basis: '',
    effectiveFrom: '',
    sourceReference: '',
    justification: '',
  });
  const propose = useMutation({
    mutationFn: () =>
      api('/config/changes', {
        method: 'POST',
        body: { kind: 'tax_rate', ...v, sourceReference: v.sourceReference || null },
      }),
    onSuccess: onClose,
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const fieldErr = (path: string) =>
    propose.error instanceof ApiError
      ? propose.error.details?.find((d) => d.path === path)?.message
      : undefined;
  return (
    <Modal open onClose={onClose} title="Propose a tax-rate change">
      <div className="space-y-3">
        {propose.error && <Alert>{propose.error.message}</Alert>}
        <Field label="Tax type" hint="e.g. VAT, EWT_RENT, DST_LEASE" error={fieldErr('taxType')}>
          {(p) => <Input {...p} value={v.taxType} onChange={set('taxType')} />}
        </Field>
        <Field label="Rate (decimal)" hint="0.12 = 12%" error={fieldErr('rate')}>
          {(p) => <Input {...p} inputMode="decimal" value={v.rate} onChange={set('rate')} />}
        </Field>
        <Field label="Basis" error={fieldErr('basis')}>
          {(p) => <Input {...p} value={v.basis} onChange={set('basis')} />}
        </Field>
        <Field label="Effective from" error={fieldErr('effectiveFrom')}>
          {(p) => (
            <Input {...p} type="date" value={v.effectiveFrom} onChange={set('effectiveFrom')} />
          )}
        </Field>
        <Field label="Legal reference" hint="RR / RMC / law section">
          {(p) => <Input {...p} value={v.sourceReference} onChange={set('sourceReference')} />}
        </Field>
        <Field label="Justification" error={fieldErr('justification')}>
          {(p) => (
            <Textarea {...p} rows={2} value={v.justification} onChange={set('justification')} />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={propose.isPending} onClick={() => propose.mutate()}>
            Submit for approval
          </Button>
        </div>
      </div>
    </Modal>
  );
}
