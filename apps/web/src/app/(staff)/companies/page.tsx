'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { CompanyDto, CreateCompanyRequest, PropertyDto } from '@crm/contracts';
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
} from '@crm/ui';
import { ApiError, api } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';

type Company = z.infer<typeof CompanyDto>;
type Property = z.infer<typeof PropertyDto>;
type CreateInput = z.input<typeof CreateCompanyRequest>;

export default function CompaniesPage() {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const canWrite = useCan('company.write');
  const list = useQuery({
    queryKey: ['companies', q],
    queryFn: () =>
      api<{ items: Company[] }>(`/companies?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });
  return (
    <>
      <PageHeader
        title="Companies"
        description="Tenants and prospects in your scope. TINs are masked; revealing one is logged."
        actions={canWrite && <Button onClick={() => setCreating(true)}>New company</Button>}
      />
      <Card>
        <div className="mb-4 max-w-sm">
          <Input
            aria-label="Search companies"
            placeholder="Search by name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Table
          head={['Legal name', 'Trade name', 'TIN', 'VAT', 'Status', 'KYC']}
          empty={list.data?.items.length === 0 ? 'No companies found.' : undefined}
        >
          {list.data?.items.map((c) => (
            <tr key={c.id}>
              <Td>
                <Link
                  className="font-medium text-brand-700 hover:underline"
                  href={`/companies/${c.id}`}
                >
                  {c.legalName}
                </Link>
              </Td>
              <Td>{c.tradeName ?? '—'}</Td>
              <Td className="font-mono">{c.tinMasked ?? '—'}</Td>
              <Td>{c.vatStatus.replace('_', '-')}</Td>
              <Td>
                <Badge
                  tone={c.status === 'TENANT' ? 'green' : c.status === 'BLOCKED' ? 'red' : 'slate'}
                >
                  {c.status}
                </Badge>
              </Td>
              <Td>
                {c.kycStatus ? (
                  <Badge tone={c.kycStatus === 'VERIFIED' ? 'green' : 'amber'}>{c.kycStatus}</Badge>
                ) : (
                  '—'
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {creating && <CreateCompany onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateCompany({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const needsProperty = !me.grants.some(
    (g) => g.scopeType === 'GLOBAL' && ['LEASING_HEAD', 'LEASING_MANAGER'].includes(g.role),
  );
  const properties = useQuery({
    queryKey: ['properties'],
    queryFn: () => api<Property[]>('/properties'),
  });
  const form = useForm<CreateInput>({
    resolver: zodResolver(CreateCompanyRequest),
    defaultValues: { registrationType: 'SEC', vatStatus: 'VAT' },
  });
  const create = useMutation({
    mutationFn: (body: CreateInput) => api<Company>('/companies', { method: 'POST', body }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['companies'] });
      router.push(`/companies/${c.id}`);
    },
  });
  const err = (k: keyof CreateInput) => form.formState.errors[k]?.message as string | undefined;

  return (
    <Modal open onClose={onClose} title="New company">
      <form className="space-y-4" onSubmit={form.handleSubmit((v) => create.mutate(v))}>
        {create.error && (
          <Alert>
            {create.error instanceof ApiError
              ? create.error.message
              : 'Could not create the company'}
          </Alert>
        )}
        <Field label="Legal name" error={err('legalName')}>
          {(p) => <Input {...p} {...form.register('legalName')} />}
        </Field>
        <Field label="Trade name" error={err('tradeName')}>
          {(p) => <Input {...p} {...form.register('tradeName')} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Registration" error={err('registrationType')}>
            {(p) => (
              <Select {...p} {...form.register('registrationType')}>
                {['SEC', 'DTI', 'CDA', 'GOVERNMENT', 'FOREIGN', 'OTHER'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Registration no." error={err('registrationNo')}>
            {(p) => <Input {...p} {...form.register('registrationNo')} />}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="TIN" hint="Stored encrypted" error={err('tin')}>
            {(p) => (
              <Input
                {...p}
                autoComplete="off"
                placeholder="123-456-789-000"
                {...form.register('tin', { setValueAs: (v: string) => v || null })}
              />
            )}
          </Field>
          <Field label="VAT status" error={err('vatStatus')}>
            {(p) => (
              <Select {...p} {...form.register('vatStatus')}>
                <option value="VAT">VAT-registered</option>
                <option value="NON_VAT">Non-VAT</option>
                <option value="VAT_EXEMPT">VAT-exempt</option>
                <option value="ZERO_RATED">Zero-rated</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label={needsProperty ? 'Property (required)' : 'Property'} error={err('propertyId')}>
          {(p) => (
            <Select
              {...p}
              {...form.register('propertyId', { setValueAs: (v: string) => v || undefined })}
            >
              <option value="">{needsProperty ? 'Choose…' : 'None'}</option>
              {properties.data?.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.code} — {pr.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
