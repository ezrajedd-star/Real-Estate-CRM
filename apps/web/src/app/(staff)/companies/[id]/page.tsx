'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import type { z } from 'zod';
import type { CompanyDto, KycDto } from '@crm/contracts';
import { Alert, Badge, Card, PageHeader, Table, Td, formatDate } from '@crm/ui';
import { RevealableValue } from '@/components/reveal';
import { ApiError, api } from '@/lib/api';
import { useCan } from '@/lib/auth';

type Company = z.infer<typeof CompanyDto>;
type Kyc = z.infer<typeof KycDto>;

export default function CompanyPage() {
  const { id } = useParams<{ id: string }>();
  const canRevealTin = useCan('pii.reveal.tin');
  const canKyc = useCan('kyc.read');
  const company = useQuery({
    queryKey: ['company', id],
    queryFn: () => api<Company>(`/companies/${id}`),
  });
  const kyc = useQuery({
    queryKey: ['kyc', id],
    queryFn: () => api<Kyc | null>(`/companies/${id}/kyc`),
    enabled: canKyc,
  });

  if (company.error) {
    return (
      <Alert>
        {company.error instanceof ApiError && company.error.status === 404
          ? 'Company not found or not in your scope.'
          : 'Could not load the company.'}
      </Alert>
    );
  }
  const c = company.data;
  if (!c) return <p className="text-slate-500">Loading…</p>;

  return (
    <>
      <PageHeader title={c.legalName} description={c.tradeName ?? undefined} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Registration">
          <dl className="grid grid-cols-3 gap-y-2 text-sm">
            <dt className="text-slate-500">Registration</dt>
            <dd className="col-span-2">
              {c.registrationType} {c.registrationNo ?? ''}
            </dd>
            <dt className="text-slate-500">TIN</dt>
            <dd className="col-span-2">
              <RevealableValue
                masked={c.tinMasked}
                endpoint={`/companies/${c.id}/reveal`}
                field="tin"
                label="TIN"
                canReveal={canRevealTin}
              />
            </dd>
            <dt className="text-slate-500">VAT status</dt>
            <dd className="col-span-2">{c.vatStatus}</dd>
            <dt className="text-slate-500">Status</dt>
            <dd className="col-span-2">
              <Badge>{c.status}</Badge>
            </dd>
            <dt className="text-slate-500">Address</dt>
            <dd className="col-span-2">{c.registeredAddress ?? '—'}</dd>
            <dt className="text-slate-500">Updated</dt>
            <dd className="col-span-2">{formatDate(c.updatedAt)}</dd>
          </dl>
        </Card>
        {canKyc && (
          <Card title="KYC">
            {kyc.data ? (
              <dl className="grid grid-cols-3 gap-y-2 text-sm">
                <dt className="text-slate-500">Status</dt>
                <dd className="col-span-2">
                  <Badge tone={kyc.data.status === 'VERIFIED' ? 'green' : 'amber'}>
                    {kyc.data.status}
                  </Badge>
                </dd>
                <dt className="text-slate-500">Risk</dt>
                <dd className="col-span-2">{kyc.data.riskRating ?? '—'}</dd>
                <dt className="text-slate-500">Next review</dt>
                <dd className="col-span-2">{formatDate(kyc.data.nextReviewOn)}</dd>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">No KYC profile yet.</p>
            )}
          </Card>
        )}
      </div>
      {c.contacts && (
        <Card title="Contacts" className="mt-4">
          <Table
            head={['Name', 'Role', 'Title', 'Email', 'Phone', 'Since']}
            empty={c.contacts.length === 0 ? 'No contacts yet.' : undefined}
          >
            {c.contacts.map((p) => (
              <tr key={p.id}>
                <Td>{p.fullName}</Td>
                <Td>{p.role.replace(/_/g, ' ')}</Td>
                <Td>{p.title ?? '—'}</Td>
                <Td className="font-mono">{p.emailMasked ?? '—'}</Td>
                <Td className="font-mono">{p.phoneMasked ?? '—'}</Td>
                <Td>{formatDate(p.effectiveFrom)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
