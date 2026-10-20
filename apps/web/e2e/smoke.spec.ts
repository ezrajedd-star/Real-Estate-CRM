import { randomInt } from 'node:crypto';
import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';
import { maskEmail } from '@crm/domain';
import { E2E_USERS } from './support/global-setup';

async function signIn(page: Page, email: string, otp: string | null = '123456') {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login|localhost:8180/);
  if (page.url().includes('/login')) await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('any-password-test-idp');
  if (otp) await page.getByLabel('Authenticator code').fill(otp);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const tin = () => `${randomInt(100, 999)}-${randomInt(100, 999)}-${randomInt(100, 999)}-000`;

test('password-only sign-in is refused (MFA required)', async ({ page }) => {
  await signIn(page, E2E_USERS.head, null);
  await expect(page).toHaveURL(/\/login\?error=MFA_REQUIRED/);
  await expect(page.getByText('Multi-factor authentication is required')).toBeVisible();
});

test('leasing head: sign in, create a company, reveal its TIN, import contacts', async ({
  page,
  context,
}) => {
  await signIn(page, E2E_USERS.head);
  await expect(page.getByTestId('current-user')).toContainText('leasing head');

  // The session cookie is httpOnly, Secure, SameSite=Strict and invisible to scripts.
  const cookies = await context.cookies();
  const sid = cookies.find((c) => c.name === '__Host-sid');
  expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('sid');

  // Create a company with a TIN
  const companyTin = tin();
  const name = `E2E Tenant ${randomInt(1000, 9999)} Corp`;
  await page.getByRole('link', { name: 'Companies' }).click();
  await page.getByRole('button', { name: 'New company' }).click();
  await page.getByLabel('Legal name').fill(name);
  await page.getByLabel('TIN').fill(companyTin);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  // Masked by default; reveal requires a reason and shows the clear value
  await expect(page.getByTestId('tin-value')).toHaveText('•••-•••-•••-000');
  await page.getByRole('button', { name: 'Reveal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reveal TIN' });
  await dialog.getByLabel('Reason').fill('Preparing the lease contract');
  await dialog.getByRole('button', { name: 'Reveal' }).click();
  await expect(page.getByTestId('tin-value')).toHaveText(companyTin.replace(/-/g, ''));

  // Import a contacts workbook for that company
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contacts');
  ws.addRow(['Company TIN', 'Full Name', 'Role', 'Title', 'Email', 'Phone']);
  ws.addRow([
    companyTin,
    'Maria Santos',
    'SIGNATORY',
    'President',
    'maria.santos@e2e.test',
    '+63 917 555 0101',
  ]);
  ws.addRow([
    companyTin,
    'Jose Rizal',
    'BILLING_CONTACT',
    'Finance Manager',
    'jose.rizal@e2e.test',
    '+63 917 555 0102',
  ]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  await page.getByRole('link', { name: 'Imports' }).click();
  await page.getByLabel('Import type').selectOption('contacts');
  await page.getByLabel('Workbook (.xlsx)').setInputFiles({
    name: 'contacts.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  await page.getByRole('button', { name: 'Upload & validate' }).click();
  await expect(page.getByText('2 rows, 0 with errors')).toBeVisible({ timeout: 30_000 });
  // Preview masks contact PII
  await expect(page.getByText(maskEmail('maria.santos@e2e.test'))).toBeVisible();
  await expect(page.getByText('maria.santos@e2e.test')).toHaveCount(0);
  await page.getByRole('button', { name: 'Commit 2 rows' }).click();
  await expect(page.getByText('COMMITTED')).toBeVisible();

  // Contacts now appear (masked) on the company
  await page.getByRole('link', { name: 'Companies' }).click();
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('cell', { name: 'Maria Santos' })).toBeVisible();
  await expect(page.getByRole('cell', { name: maskEmail('maria.santos@e2e.test') })).toBeVisible();

  // Sign out ends the server-side session
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/localhost:8180|\/login/);
  const res = await page.request.get('/api/v1/auth/me');
  expect(res.status()).toBe(401);
});

test('pages send a strict CSP with a per-request nonce', async ({ request }) => {
  const a = await request.get('/login');
  const b = await request.get('/login');
  const csp = a.headers()['content-security-policy']!;
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).not.toEqual(b.headers()['content-security-policy']);
  expect(a.headers()['x-frame-options']).toBe('DENY');
});
