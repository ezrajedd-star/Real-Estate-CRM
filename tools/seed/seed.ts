/**
 * Phase 1 seed: synthetic staff, properties, companies/contacts/KYC, config and tax-rate
 * rows, and a privacy notice. Idempotent (safe to re-run). All people, TINs, emails and
 * phone numbers are fictitious. The full §11 leasing seed (≈80 spaces, ≈30 tenants, a year
 * of billing) arrives with Phases 2–3.
 *
 * Every rate and threshold below is a DEMO DEFAULT marked needs_confirmation = true; the
 * accountant/lawyer must confirm each one before go-live. Negotiated lease terms (deposit,
 * advance, escalation, penalty, commission) deliberately have NO defaults here.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createDb, uuidv7 } from '@crm/db';
import { normalizeTin } from '@crm/domain';
import { DbKeyStore, FieldCipher, keyProviderFromEnv } from '@crm/platform';

const MIGRATOR_URL = process.env.DATABASE_URL_MIGRATOR;
const WORKER_URL = process.env.DATABASE_URL_WORKER;
if (!MIGRATOR_URL || !WORKER_URL)
  throw new Error('Set DATABASE_URL_MIGRATOR and DATABASE_URL_WORKER');
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed: never run the seed against production');
}

const db = new pg.Client({ connectionString: MIGRATOR_URL });
await db.connect();
// Data keys are created through the worker role so key handling matches runtime behaviour.
const keyDb = createDb(WORKER_URL, { max: 1 });
const cipher = new FieldCipher(keyProviderFromEnv(), new DbKeyStore(keyDb.db));

const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;

// ---------------------------------------------------------------- staff (one per role)
// Emails match the accounts you create in Keycloak locally; the app links on first login.
const STAFF = [
  ['it.admin@example.test', 'Ia Admin', 'SUPER_ADMIN', 'GLOBAL'],
  ['owner@example.test', 'Olivia Owner', 'EXECUTIVE', 'GLOBAL'],
  ['leasing.head@example.test', 'Luis Head', 'LEASING_HEAD', 'GLOBAL'],
  ['manager.office@example.test', 'Mara Office', 'LEASING_MANAGER', 'PROPERTY:PMO-OFC'],
  ['manager.retail@example.test', 'Rico Retail', 'LEASING_MANAGER', 'PROPERTY:PMO-RTL'],
  ['officer@example.test', 'Ola Officer', 'LEASING_OFFICER', 'COMPANY:first'],
  ['billing@example.test', 'Bea Billing', 'BILLING_OFFICER', 'GLOBAL'],
  ['property.admin@example.test', 'Pia Property', 'PROPERTY_OFFICER', 'GLOBAL'],
  ['finance@example.test', 'Fe Finance', 'FINANCE', 'GLOBAL'],
  ['dpo@example.test', 'Dante DPO', 'COMPLIANCE_DPO', 'GLOBAL'],
  ['auditor@example.test', 'Aida Auditor', 'INTERNAL_AUDITOR', 'GLOBAL'],
] as const;

// ---------------------------------------------------------------- properties
const props: Record<string, string> = {};
for (const [code, name, address] of [
  ['PMO-OFC', 'Ayala Avenue Office Tower', 'Ayala Ave., Makati City'],
  ['PMO-RTL', 'Ortigas Retail Arcade', 'Ortigas Center, Pasig City'],
] as const) {
  const r = await one<{ id: string }>(
    `INSERT INTO properties.property (code, name, address) VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [code, name, address],
  );
  props[code] = r.id;
}

// ---------------------------------------------------------------- companies & contacts
const COMPANIES: Array<{
  name: string;
  trade: string;
  reg: 'SEC' | 'DTI';
  tin: string;
  vat: string;
  property: string;
  industry: string;
  kyc: string;
  status: string;
}> = [
  {
    name: 'Bayanihan Software Solutions Inc.',
    trade: 'Bayanihan Soft',
    reg: 'SEC',
    tin: '900-100-001-000',
    vat: 'VAT',
    property: 'PMO-OFC',
    industry: 'IT-BPM',
    kyc: 'VERIFIED',
    status: 'TENANT',
  },
  {
    name: 'Kalayaan Legal Partners',
    trade: 'Kalayaan Law',
    reg: 'SEC',
    tin: '900-100-002-000',
    vat: 'VAT',
    property: 'PMO-OFC',
    industry: 'Professional services',
    kyc: 'VERIFIED',
    status: 'TENANT',
  },
  {
    name: 'Mabuhay Outsourcing Corp.',
    trade: 'Mabuhay BPO',
    reg: 'SEC',
    tin: '900-100-003-000',
    vat: 'VAT',
    property: 'PMO-OFC',
    industry: 'IT-BPM',
    kyc: 'IN_REVIEW',
    status: 'TENANT',
  },
  {
    name: 'Silangan Engineering Consultants',
    trade: 'Silangan Eng',
    reg: 'SEC',
    tin: '900-100-004-000',
    vat: 'VAT',
    property: 'PMO-OFC',
    industry: 'Engineering',
    kyc: 'PENDING',
    status: 'PROSPECT',
  },
  {
    name: 'Tala Fintech Holdings Inc.',
    trade: 'Tala Pay',
    reg: 'SEC',
    tin: '900-100-005-000',
    vat: 'VAT',
    property: 'PMO-OFC',
    industry: 'Financial services',
    kyc: 'VERIFIED',
    status: 'TENANT',
  },
  {
    name: 'Kape Kultura Food Corp.',
    trade: 'Kape Kultura',
    reg: 'SEC',
    tin: '900-200-001-000',
    vat: 'VAT',
    property: 'PMO-RTL',
    industry: 'F&B',
    kyc: 'VERIFIED',
    status: 'TENANT',
  },
  {
    name: 'Sampaguita Apparel Trading',
    trade: 'Sampaguita',
    reg: 'DTI',
    tin: '900-200-002-000',
    vat: 'NON_VAT',
    property: 'PMO-RTL',
    industry: 'Retail - apparel',
    kyc: 'VERIFIED',
    status: 'TENANT',
  },
  {
    name: 'Lakbay Travel Kiosk',
    trade: 'Lakbay',
    reg: 'DTI',
    tin: '900-200-003-000',
    vat: 'NON_VAT',
    property: 'PMO-RTL',
    industry: 'Services - kiosk',
    kyc: 'PENDING',
    status: 'PROSPECT',
  },
  {
    name: 'Halo-Halo Republic Inc.',
    trade: 'Halo-Halo Republic',
    reg: 'SEC',
    tin: '900-200-004-000',
    vat: 'VAT',
    property: 'PMO-RTL',
    industry: 'F&B',
    kyc: 'VERIFIED',
    status: 'TENANT',
  },
  {
    name: 'Bituin Mobile Accessories',
    trade: 'Bituin Mobile',
    reg: 'DTI',
    tin: '900-200-005-000',
    vat: 'VAT',
    property: 'PMO-RTL',
    industry: 'Retail - electronics',
    kyc: 'REJECTED',
    status: 'FORMER_TENANT',
  },
];

const FIRST = [
  'Maria',
  'Jose',
  'Ana',
  'Ramon',
  'Liza',
  'Paolo',
  'Grace',
  'Miguel',
  'Carmela',
  'Andres',
];
const LAST = [
  'Santos',
  'Reyes',
  'Cruz',
  'Bautista',
  'Garcia',
  'Mendoza',
  'Torres',
  'Flores',
  'Villanueva',
  'Ramos',
];

const companyIds: string[] = [];
for (const [i, c] of COMPANIES.entries()) {
  const normalized = normalizeTin(c.tin);
  const bidx = await cipher.blindIndex('company.tin', normalized);
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM contacts.company WHERE tin_bidx = $1`,
    [bidx],
  );
  let id = existing.rows[0]?.id;
  if (!id) {
    id = uuidv7();
    const enc = await cipher.encrypt('tin', normalized, {
      table: 'contacts.company',
      column: 'tin_enc',
      rowId: id,
    });
    await db.query(
      `INSERT INTO contacts.company (id, legal_name, trade_name, registration_type, registration_no, tin_enc, tin_bidx, tin_last3, vat_status, registered_address, industry, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        c.name,
        c.trade,
        c.reg,
        `${c.reg}-DEMO-${1000 + i}`,
        enc,
        bidx,
        normalized.slice(9),
        c.vat,
        'Metro Manila (synthetic)',
        c.industry,
        c.status,
      ],
    );
    await db.query(
      `INSERT INTO contacts.company_property (company_id, property_id, relation) VALUES ($1, $2, $3)`,
      [
        id,
        props[c.property],
        c.status === 'FORMER_TENANT'
          ? 'FORMER_TENANT'
          : c.status === 'PROSPECT'
            ? 'PROSPECT'
            : 'TENANT',
      ],
    );
    await db.query(
      `INSERT INTO contacts.kyc_profile (company_id, status, risk_rating) VALUES ($1, $2, $3)`,
      [id, c.kyc, i % 4 === 0 ? 'MEDIUM' : 'LOW'],
    );
    for (const [j, role] of (['SIGNATORY', 'BILLING_CONTACT'] as const).entries()) {
      const first = FIRST[(i + j * 3) % FIRST.length]!;
      const last = LAST[(i * 2 + j) % LAST.length]!;
      const p = await one<{ id: string }>(
        `INSERT INTO contacts.person (full_name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
        [
          `${first} ${last}`,
          `${first}.${last}.${i}${j}@example.test`.toLowerCase(),
          `+63 917 555 ${String(1000 + i * 10 + j).slice(-4)}`,
        ],
      );
      await db.query(
        `INSERT INTO contacts.company_contact_role (company_id, person_id, role, title) VALUES ($1, $2, $3, $4)`,
        [id, p.id, role, role === 'SIGNATORY' ? 'President' : 'Finance Manager'],
      );
    }
  }
  companyIds.push(id);
}

// ---------------------------------------------------------------- staff + scoped roles
for (const [email, name, role, scope] of STAFF) {
  // Pre-provisioned: the person's first Keycloak login with this email claims the row.
  const u = await one<{ user_id: string }>(`SELECT identity.preprovision_user($1, $2) AS user_id`, [
    email,
    name,
  ]);
  const [scopeType, ref] = scope.split(':') as [
    'GLOBAL' | 'PROPERTY' | 'COMPANY',
    string | undefined,
  ];
  const scopeId =
    scopeType === 'PROPERTY' ? props[ref!] : scopeType === 'COMPANY' ? companyIds[0] : null;
  await db.query(
    `INSERT INTO identity.role_assignment (user_id, role, scope_type, scope_id)
     SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM identity.role_assignment
       WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL)`,
    [u.user_id, role, scopeType, scopeId],
  );
}

// ---------------------------------------------------------------- tax rates (DEMO, needs confirmation)
const RATES: Array<[string, string | null, unknown, string, string, string]> = [
  [
    'VAT',
    '0.120000',
    null,
    'Output VAT on commercial lease rentals and charges',
    'NIRC Sec. 108 as amended (TRAIN, RA 10963); invoicing per EOPT Act RA 11976',
    '2018-01-01',
  ],
  [
    'EWT_RENT',
    '0.050000',
    null,
    'Expanded withholding tax on rentals of real property, withheld by tenants (Form 2307)',
    'RR 2-98 Sec. 2.57.2(B) as amended',
    '2018-01-01',
  ],
  [
    'EWT_BROKER',
    null,
    {
      type: 'threshold',
      unit: 'annual_gross_income_php',
      bands: [
        { upTo: '3000000.00', rate: '0.10' },
        { above: '3000000.00', rate: '0.15' },
      ],
    },
    'Expanded withholding on broker commissions (individual professionals); rate depends on gross income / sworn declaration',
    'RR 2-98 Sec. 2.57.2(A) as amended by RR 11-2018',
    '2018-01-01',
  ],
  [
    'DST_LEASE',
    null,
    {
      type: 'per_unit',
      basis: 'annual_rent_php',
      first: { upTo: '2000.00', amount: '6.00' },
      each: { per: '1000.00', amount: '2.00' },
      multiplyBy: 'term_years',
    },
    'Documentary stamp tax on lease contracts: ₱6 for the first ₱2,000 of annual rent + ₱2 per additional ₱1,000, per year of term',
    'NIRC Sec. 194 as amended by RA 10963',
    '2018-01-01',
  ],
];
for (const [taxType, rate, brackets, basis, ref, from] of RATES) {
  await db.query(
    `INSERT INTO config.tax_rate (tax_type, rate, brackets, basis, source_reference, effective_from, needs_confirmation)
     SELECT $1, $2, $3, $4, $5, $6, true WHERE NOT EXISTS (SELECT 1 FROM config.tax_rate WHERE tax_type = $1)`,
    [taxType, rate, brackets === null ? null : JSON.stringify(brackets), basis, ref, from],
  );
}

// ---------------------------------------------------------------- config values (DEMO, needs confirmation)
const CONFIG: Array<[string, unknown, string]> = [
  [
    'reminders.offsets_days',
    {
      prepareBilling: -10,
      contactBeforeDue: -5,
      followUp1: 1,
      followUp2: 7,
      escalateHead: 15,
      escalateFinance: 30,
      docExpiry: -30,
      leaseExpiry: [-180, -90, -60, -30],
    },
    'Seed defaults from brief §3.3 [CONFIRM offsets]',
  ],
  ['reminders.daily_digest_time', '08:00', 'Asia/Manila'],
  ['brokers.tag_window_days', 90, 'Broker prospect ownership window [CONFIRM window]'],
  ['brokers.license_alert_days', [60, 30, 7], 'PRC license expiry alerts (brief §3.4)'],
  [
    'privacy.breach_npc_notify_hours',
    72,
    'NPC Circular 16-03: notify within 72 hours of knowledge',
  ],
  ['privacy.breach_full_report_days', 5, 'NPC full report deadline [CONFIRM with DPO]'],
  [
    'aml.cash_payment_flag_php',
    '500000.00',
    'Flag single cash payments for Compliance review [CONFIRM with counsel]',
  ],
];
for (const [key, value, notes] of CONFIG) {
  await db.query(
    `INSERT INTO config.config_value (key, value, effective_from, needs_confirmation, notes)
     SELECT $1, $2, '2026-01-01', true, $3 WHERE NOT EXISTS (SELECT 1 FROM config.config_value WHERE key = $1)`,
    [key, JSON.stringify(value), notes],
  );
}

// ---------------------------------------------------------------- privacy notice v1
const body = `# Privacy Notice for Tenant Representatives (DEMO TEXT — replace with DPO-approved notice)

We process the personal data of signatories, billing contacts, guarantors and beneficial owners of our
commercial tenants to administer leases, bill and collect payments, meet tax and anti-money-laundering
obligations, and communicate with you about your lease. Lawful bases: contract, legal obligation and
legitimate interest; marketing only with your consent. Contact our Data Protection Officer at
dpo@example.test to exercise your rights under the Data Privacy Act of 2012.`;
await db.query(
  `INSERT INTO contacts.privacy_notice (version_label, audience, title, body_markdown, body_sha256, effective_from)
   VALUES ('tenant-contact-v1', 'TENANT_CONTACT', 'Privacy notice for tenant representatives', $1, $2, '2026-01-01')
   ON CONFLICT (version_label) DO NOTHING`,
  [body, createHash('sha256').update(body).digest('hex')],
);

await db.end();
await keyDb.close();
process.stdout.write(
  `Seeded ${Object.keys(props).length} properties, ${COMPANIES.length} companies, ${STAFF.length} staff, ${RATES.length} tax rates, ${CONFIG.length} config values.\n`,
);
