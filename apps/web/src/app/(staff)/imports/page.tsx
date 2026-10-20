'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import type { ImportPreviewDto, PropertyDto } from '@crm/contracts';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Table, Td } from '@crm/ui';
import { ApiError, api } from '@/lib/api';

type Preview = z.infer<typeof ImportPreviewDto>;
type Property = z.infer<typeof PropertyDto>;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Import wizard: upload (presigned, scanned for malware) → validate (row errors, masked
 * preview) → commit. Nothing is written to the register until commit.
 */
export default function ImportsPage() {
  const [importType, setImportType] = useState<'companies' | 'contacts'>('companies');
  const [propertyId, setPropertyId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const properties = useQuery({
    queryKey: ['properties'],
    queryFn: () => api<Property[]>('/properties'),
  });
  const qc = useQueryClient();

  const run = async () => {
    if (!file) return;
    setError(null);
    setPreview(null);
    try {
      setStep('Uploading…');
      const init = await api<{
        documentId: string;
        uploadUrl: string;
        headers: Record<string, string>;
      }>('/documents', {
        method: 'POST',
        body: {
          ownerType: 'import_batch',
          ownerId: crypto.randomUUID(),
          category: 'IMPORT_FILE',
          originalName: file.name,
          contentType: XLSX,
          sizeBytes: file.size,
        },
      });
      const put = await fetch(init.uploadUrl, { method: 'PUT', body: file, headers: init.headers });
      if (!put.ok) throw new Error('Upload failed');
      await api(`/documents/${init.documentId}/complete`, { method: 'POST' });

      setStep('Scanning for malware…');
      for (let i = 0; ; i++) {
        const doc = await api<{ status: string }>(`/documents/${init.documentId}`);
        if (doc.status === 'CLEAN') break;
        if (doc.status !== 'QUARANTINED' || i > 60)
          throw new Error(`The file was rejected (${doc.status.toLowerCase()})`);
        await new Promise((r) => setTimeout(r, 1000));
      }

      setStep('Validating rows…');
      const batch = await api<{ id: string }>('/imports', {
        method: 'POST',
        body: { importType, documentId: init.documentId, propertyId: propertyId || null },
      });
      setPreview(await api<Preview>(`/imports/${batch.id}/validate`, { method: 'POST' }));
      setStep(null);
    } catch (e) {
      setStep(null);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const commit = async () => {
    if (!preview) return;
    try {
      setStep('Committing…');
      setPreview(await api<Preview>(`/imports/${preview.batch.id}/commit`, { method: 'POST' }));
      // Imported rows change companies and their contacts; drop cached views of them.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['companies'] }),
        qc.invalidateQueries({ queryKey: ['company'] }),
      ]);
      setStep(null);
    } catch (e) {
      setStep(null);
      setError(e instanceof ApiError ? e.message : 'Commit failed');
    }
  };

  const columns = preview?.rows[0] ? Object.keys(preview.rows[0].preview) : [];
  return (
    <>
      <PageHeader
        title="Excel import"
        description="Migrate existing companies and contacts. Sensitive columns are encrypted and masked in the preview."
      />
      <Card title="1. Upload a workbook">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Import type">
            {(p) => (
              <Select
                {...p}
                value={importType}
                onChange={(e) => setImportType(e.target.value as typeof importType)}
              >
                <option value="companies">Companies</option>
                <option value="contacts">Contacts</option>
              </Select>
            )}
          </Field>
          <Field label="Property" hint="Required if your access is property-scoped">
            {(p) => (
              <Select {...p} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                <option value="">None</option>
                {properties.data?.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.code} — {pr.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Workbook (.xlsx)">
            {(p) => (
              <Input
                {...p}
                type="file"
                accept=".xlsx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            )}
          </Field>
          <div className="flex items-end">
            <Button disabled={!file || !!step} onClick={run}>
              Upload & validate
            </Button>
          </div>
        </div>
        {step && (
          <p className="mt-3 text-sm text-slate-600" role="status">
            {step}
          </p>
        )}
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
      </Card>

      {preview && (
        <Card
          className="mt-4"
          title={
            <span>
              2. Preview — {preview.batch.totalRows} rows, {preview.batch.errorRows} with errors{' '}
              <Badge tone={preview.batch.status === 'COMMITTED' ? 'green' : 'blue'}>
                {preview.batch.status}
              </Badge>
            </span>
          }
          actions={
            preview.batch.status === 'VALIDATED' && (
              <Button disabled={preview.batch.errorRows > 0 || !!step} onClick={commit}>
                Commit {preview.batch.validRows} rows
              </Button>
            )
          }
        >
          {preview.batch.errorRows > 0 && (
            <div className="mb-3">
              <Alert tone="amber">
                Fix the rows with errors in Excel and upload the corrected file as a new import.
              </Alert>
            </div>
          )}
          <Table head={['Row', ...columns, 'Errors']}>
            {preview.rows.map((r) => (
              <tr key={r.rowNumber} className={r.errors.length ? 'bg-red-50' : undefined}>
                <Td>{r.rowNumber}</Td>
                {columns.map((c) => (
                  <Td key={c}>{r.preview[c] ?? ''}</Td>
                ))}
                <Td className="whitespace-normal text-red-700">
                  {r.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
