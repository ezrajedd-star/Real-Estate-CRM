# Build Brief: Commercial Leasing CRM (Philippines)

> **To Claude Code:** This file is the complete brief for a new project. Read it fully before writing code. Start in **plan mode**: propose the repo structure, data model, and Phase 1 plan, and wait for my approval before implementing. Build in the phases listed in §12. After approval, create a `CLAUDE.md` at the repo root summarising the conventions in §11 and the security rules in §8 so they persist across sessions.
>
> I am not a real-estate domain expert. Where this brief says **[CONFIRM]**, ask me before hard-coding a business rule. All tax rates, thresholds and legal periods must live in **configuration tables with effective dates**, never in code, because Philippine rules change and must be validated by our accountant/lawyer.
>
> **Scope:** This system covers **commercial leasing only**. Residential unit sales will be a **separate system** built later. Do not build sales features, but design `contacts`, `identity` and `audit` so the two systems can later share a single sign-on provider and exchange contact data through an API (see §9.3).

---

## 1. Business context

A Philippine real estate company leases commercial space (office, retail, kiosks, storage, possibly warehouse) to business tenants on multi-year contracts. Revenue is monthly base rent plus common-area/service charges, utilities and other recoveries. Some deals come through **third-party leasing brokers** who earn commissions.

The system must manage the full tenant lifecycle — prospecting, proposals, contracts, fit-out, billing, collections, renewals and move-out — and the **receivables expected from each tenant**, with a reminder engine that tells the **Leasing Manager when to contact each tenant about billing and payment**.

It holds **sensitive personal and financial data** (signatories' government IDs, TINs, bank details, tenant financials, payment history). Security is a first-class requirement, not an add-on.

Locale: currency **PHP (₱)**, timezone **Asia/Manila**, English UI (i18n-ready), dates `MMM DD, YYYY`.

---

## 2. Core features

### 2.1 Leasable space inventory
- Hierarchy: **Property → Building → Floor → Space/Unit**.
- Space attributes: gross leasable area (GLA, sqm), type (office / retail / F&B / kiosk / storage / parking), fit-out condition (bare/warm shell/fitted), frontage, utilities available, asking rent per sqm, CUSA rate, photos and floor plans.
- Status machine: `VACANT → ON_HOLD (timed, for a prospect) → RESERVED (LOI signed) → UNDER_FIT_OUT → OCCUPIED → NOTICE_TO_VACATE → VACANT`, plus `NOT_LEASABLE` (management hold / under repair). Every change audited.
- Support **combining or splitting spaces** (demising) with history preserved.
- **Stacking plan / floor view** color-coded by status and by lease expiry year; vacancy and expiry heatmap.
- Parking slots as leasable inventory attachable to a lease.

### 2.2 Prospects & leasing pipeline
- Prospect capture: inquiry form, walk-in, broker submission, referral, CSV import.
- **Broker tagging**: a broker who registers a prospect owns it for a configurable window (e.g. 60–90 days) to avoid commission disputes; duplicates detected by company name/TIN/contact; conflicts go to the Leasing Head. **[CONFIRM window]**
- Stages: Inquiry → Site Visit → Space Proposal Sent → Negotiation → LOI / Reservation Signed → Contract Signed → Fit-out → Active → Lost (reason required).
- Activity log: calls, site visits, emails, meetings, next-action date, overdue follow-up reminders.
- **Space proposal generator** (PDF): spaces, rates, escalation, CUSA, deposits/advance, rent-free period, estimated monthly cost.
- **Deal sheet & approval:** before the LOI, the deal sheet records every negotiated term:
  - rent
  - deposit and advance months
  - escalation
  - penalty
  - rent-free period
  - broker commission

  From these it computes:
  - the total contract value
  - the effective and net effective rent after rent-free months and concessions
  - the cash collected upfront

  It compares the result with the asking rent and with comparable leases in the same building.

  Every deal sheet goes through approval: Leasing Head, then Executive above configurable thresholds. **[CONFIRM approval thresholds]**

### 2.3 Lease contracts
- Tenant (company) record: SEC/DTI registration, TIN, VAT status, authorized signatories (with board resolution/secretary's certificate), billing contacts, guarantors if any.
- **Negotiated terms principle (confirmed by the business):** security deposit months, advance rent months, escalation, late-payment penalty and broker commission are **always negotiated per deal**. There are **no fixed company defaults** for these. The system must:
  - Capture them as **per-lease fields** (per-deal for commissions), entered on the deal sheet and carried into the lease.
  - Allow optional **term templates** (e.g. "Standard office", "Retail kiosk") that only **pre-fill** the form and can be overridden field by field. Templates are optional; a lease with no template is valid.
  - Never apply a hidden or global default to a live lease. If a negotiated field is blank, block lease activation until it is filled in or explicitly marked "None / 0".
  - Version every change to a negotiated term through a lease amendment, with who changed it, when, the reason, and the approval trail.
  - Show the negotiated values clearly on the lease summary and the deal sheet, and report on them across the portfolio, e.g. average deposit months or escalation % by building.
- Lease terms (versioned; amendments create new versions, never overwrite):
  - Commencement date, rent-start date, expiry date, term; **fit-out / rent-free period**.
  - Base rent: per sqm × GLA or fixed amount.
  - **Escalation (negotiated per lease):** the escalation can be:
    - a percentage or a fixed amount
    - at any frequency (annual, every 2 years, or a custom schedule)
    - starting from any anniversary
    - compounding or simple
    - a **stepped schedule**, with a different % for each year
    - **none**

    It can apply separately to base rent and to CUSA.
  - **CUSA / CAM** (common area & service charges): fixed per sqm, with optional escalation.
  - Utilities: submetered electricity, water, chilled water/aircon (meter IDs and rates); fixed or pass-through.
  - Other recurring charges: parking, signage, marketing fund, after-hours aircon, real property tax pass-through (if contracted).
  - **Security deposit and advance rent (negotiated per lease):** entered as a number of months **or** a fixed peso amount. The system computes the peso value from the agreed rent. Advance rent records which months it will be applied to (e.g. the first 2 months or the last 2 months). A fit-out/construction bond can be recorded too.
  - **Percentage rent** for retail/F&B tenants: higher of base rent or % of gross sales, requiring monthly tenant sales reports (optional per lease). **[CONFIRM if needed]**
  - **Late-payment penalty (negotiated per lease):** the penalty is set by:
    - type: % per month on the overdue amount, % per annum, a fixed amount, or none
    - simple or compounding
    - grace days
    - an optional cap

    The **payment due day of month** is also set per lease.
  - Renewal options, pre-termination clauses and penalties, notice periods, holdover rent rate.
- Contract document generation from templates (LOI, lease contract, amendments, notices), with uploaded signed copies.
- **Documentary stamp tax** on lease contracts computed per configurable rate table and tracked as paid/unpaid. **[CONFIRM who bears it]**
- **Lease abstract** page: one-screen summary of all key terms and critical dates.

### 2.4 Critical dates & tenant compliance
- Auto-generated critical dates per lease: rent start, each escalation, option exercise deadlines, expiry, notice deadlines.
- **Expiry alerts at 180 / 90 / 60 / 30 days** to the Leasing Manager to start renewal talks; renewal pipeline view.
- Tenant compliance documents with expiry tracking and alerts: Mayor's/business permit (annual renewal), BIR Certificate of Registration, insurance certificates (CGL, property), fire safety inspection certificate, SEC/DTI documents. **[CONFIRM list]**

### 2.5 Move-in, fit-out & move-out
- Move-in checklist: deposit and advance received, contract signed, DST settled, permits, insurance, keys/access cards issued, meter opening readings.
- Fit-out tracking: plans approval, construction bond, fit-out start/end, inspection sign-off.
- Move-out checklist: notice received, final meter readings, inspection and damage assessment, restoration works, keys returned.
- **Security deposit reconciliation**: apply deposit against unpaid bills and damages, compute refund, approval workflow (maker–checker), refund payment record.

---

## 3. Billing, receivables & the Leasing Manager reminder engine (top priority)

### 3.1 Billing runs
- Monthly **billing run** per property: generates a billing statement per tenant from rent schedule (with escalations applied automatically), CUSA, utilities (from meter readings), other charges, penalties on overdue balances, and percentage rent (from sales reports).
- Pro-rating for partial months; rent-free periods respected; holdover rate after expiry if tenant hasn't vacated.
- Preview → review → approve → issue workflow; nothing goes to tenants until approved. Re-runs are idempotent.
- **Meter reading module**: enter/import readings per meter, validate against previous (flag spikes/negatives), photo attachment.
- Billing statement PDF, emailed to the tenant's billing contacts; available in the tenant portal (phase 4).
- **VAT** on rent and charges per config (12% default for commercial lease) with tenant VAT status recorded.

> **Invoicing note:** Under the EOPT Act (RA 11976) the **invoice** is the document for VAT on leases (official receipts are no longer the primary document), and a system that issues BIR invoices must be registered with the BIR. **Default design: this system issues billing statements/SOAs and payment acknowledgements and exports to the accounting system, which issues BIR invoices.** Build an invoicing module behind a feature flag, enabled only after BIR registration. **[CONFIRM with accountant]**

### 3.2 Receivables ledger
- Per-tenant ledger: billed, paid, withholding tax credited, adjustments/credit memos, balance.
- **Payment recording**: check, **post-dated checks (PDCs)**, bank transfer (InstaPay/PESONet), cash, online gateway (phase 4).
- **Payment allocation** order configurable (e.g. penalties → oldest charges first), with manual override by Finance and audit trail. **[CONFIRM order]**
- **PDC vault**: lease-start PDCs collected for the year/term; register check no., bank, amount, date, status (`ON_HAND → DEPOSITED → CLEARED / BOUNCED / REPLACED / RETURNED`). Bounced check workflow with penalty and notification.
- **Withholding tax / Form 2307**: tenants that withhold expanded withholding tax on rent pay net and must send **BIR Form 2307**. Track expected vs. received 2307 per tenant per quarter; balance shows "withheld, 2307 pending" separately from true unpaid amounts; chase missing 2307s. **[CONFIRM rates]**
- Aging buckets: current, 1–30, 31–60, 61–90, 90+ days; per tenant, per property, per leasing officer.
- Credit memos, write-offs and adjustments require approval (maker–checker).
- Demand letter generation (1st, 2nd, final demand) from templates, logged on the tenant timeline.

### 3.3 Leasing Manager notification engine (explicit requirement)
Configurable reminder rules (global defaults, overridable per property/tenant) that generate **tasks** and **notifications**:

| When | Task / message |
|---|---|
| T−10 days before billing date | Prepare billing: read meters, collect tenant sales reports (percentage-rent tenants) |
| Billing date | Review & approve billing run; statements sent |
| T−5 days before due date | **Contact Tenant X** — ₱amount due on date |
| Due date | Payment due today; PDC deposit reminder if a check is dated today |
| +1 day overdue | Follow-up call |
| +7 days | Second follow-up; 1st demand letter suggested |
| +15 days | Escalate to Leasing Head |
| +30 days | Escalate to Leasing Head + Finance; final demand suggested |
| Quarter end +N days | Chase missing Form 2307s |
| Document expiry −30 days | Request renewed permit/insurance |
| Lease expiry −180/90/60/30 days | Renewal discussion |

**[CONFIRM offsets]** — these are seed defaults, editable in settings.

- **"Today's Calls" worklist** for the Leasing Manager/Officers: every tenant to contact today, amount, days overdue, last contact, contact number — with one-click **Log call**, **record promise-to-pay date**, **note**, **send SOA**.
- **Promise-to-pay** tracking: when the promised date passes unpaid, auto-create a follow-up task.
- Channels: in-app notification center, email, SMS (provider adapter). Daily digest email to Leasing Manager at 8:00 AM Manila time. Optional templated SMS/email reminders sent **to tenants** (with approval and opt-out logging).
- Every reminder, call and message is recorded on the tenant timeline.

### 3.4 Leasing broker commissions
- Broker/brokerage records with **PRC license number and expiry**, AMLC registration certificate, BIR registration, TIN, bank details, accreditation agreement. **Alerts 60/30/7 days before license expiry; block new deal registration and commission release when expired.**
- **The commission is negotiated per deal** and recorded on the deal sheet. The basis can be:
  - N months of rent, flat or per lease year
  - % of total contract value
  - a fixed amount

  The commission record also holds:
  - an optional cap
  - the split between the broker firm and the salesperson
  - whether renewals earn a commission, and how much

  Optional commission templates pre-fill the form only.
- **Release terms are negotiated per deal too**, e.g. 50% on contract signing plus receipt of deposit/advance, then 50% after the first X months are paid. Each tranche is stored as a rule linked to a trigger: contract signed, deposit received, N months collected, or a manual milestone.
- The commission terms are attached to the deal and must be approved by the Leasing Head before any release.
- Clawback if lease is pre-terminated within a defined period.
- Withholding tax computation on releases per rate table; Form 2307 data per broker per quarter; require broker invoice reference before release.
- **Maker–checker**: Commission Officer/Leasing Officer prepares → Leasing Head approves → Finance pays.
- Light **broker portal** (phase 4): registered prospects, deals, commission status, 2307s, invoice upload.

---

## 4. Value-adding features

1. **Dashboards** (Phase 3):
   - Executive: occupancy % (by GLA), vacancy, **WALE** (weighted average lease expiry), rent roll, collections vs. billings, receivables aging, top overdue tenants, expiries by year.
   - Leasing: pipeline, deals in negotiation, renewals due, proposals sent, conversion rate.
   - Finance: billed vs. collected, 2307 pending, deposits held, cash-flow forecast.
2. **Rent roll report** (standard industry report): every space, tenant, area, rent, CUSA, escalation, expiry, deposit.
3. **Cash-flow forecast**: expected rent/charges by month from active leases, with collection-rate assumption.
4. **Tenant mix analysis** for retail (by category), occupancy cost ratio (rent ÷ tenant sales) for percentage-rent tenants.
5. **Tenant risk score**: days-to-pay trend, bounced checks, broken promises-to-pay → early warning list.
6. **Bank statement import & auto-matching** (CSV) to speed up payment posting.
7. **Accounting export** (journal entries / CSV) to the company's accounting system. **[CONFIRM system]**
8. **Tenant self-service portal** (Phase 4): view bills/SOA/payment history, download contract & statements, upload 2307s, permits and insurance certificates, submit **maintenance/work-order requests**, request after-hours aircon/access.
9. **Online payments** (Phase 4): gateway adapter (candidates: PayMongo, Xendit, Maya, DragonPay) with auto-reconciliation.
10. **E-signature** for LOIs, contracts and renewals (adapter, Phase 4).
11. **Maintenance / work orders** with SLA tracking (Phase 4).
12. **Excel import tools** with validation preview to migrate existing spaces, tenants, leases, opening balances and PDCs (Phase 1–2 — essential for go-live).
13. **Report builder** with saved filters and scheduled emails, subject to export controls in §8.
14. **AI assist (optional, later, feature-flagged)**: summarize tenant history, draft follow-up/demand messages. No PII sent to external AI services without a data processing agreement and data minimisation.

---

## 5. Philippine compliance requirements (build into the domain model)

| Area | Requirement for the system | Notes |
|---|---|---|
| **Data Privacy Act (RA 10173) & NPC rules** | Privacy notice + consent capture (versioned, timestamped) for tenant signatories/contacts and broker personnel; lawful-basis per processing purpose; data-subject request workflow (access, correction, objection, erasure where legally allowed); DPO role; records of processing; retention schedules; breach management module (§8.9). | NPC breach rule: notify NPC and affected data subjects within **72 hours** of knowledge/reasonable belief of a qualifying breach; full report within 5 days. |
| **BIR / EOPT Act (RA 11976)** | VAT on commercial leases (configurable); invoicing only through a BIR-registered system (feature flag); expanded withholding tax on rent withheld by tenants → Form 2307 tracking; withholding on broker commissions; DST on lease contracts. | All rates/thresholds in config with effective dates. **[CONFIRM with accountant]** |
| **Real Estate Service Act (RA 9646)** | Only PRC-licensed brokers can be paid broker commissions; store license and expiry; block payment if expired. | |
| **AMLA (RA 9160 as amended)** | Basic KYC on tenants (company registration, beneficial owners, authorized signatories); flag unusual cash payments for Compliance review. Threshold and applicability to leasing configurable. | **[CONFIRM with counsel]** |
| **Civil Code (lease provisions)** | Contract terms, notices and pre-termination tracked in the lease record; legal notices generated from templates with proof-of-service fields. | Rent Control Act covers residential only — not applicable here. |
| **Local government** | Tenant business permits renewed annually — tracked in §2.4. | |
| **Record retention** | Configurable retention per record type (tax, contracts, KYC, audit logs) with legal-hold override; anonymise/delete after expiry. | **[CONFIRM periods]** |

---

## 6. (Reserved — sales features out of scope for this system)

---

## 7. Users, roles & authentication

### 7.1 Internal roles (staff — MFA mandatory)
| Role | Key permissions |
|---|---|
| **Super Admin (IT)** | System config, users, roles, integrations. **No default access to tenant PII or financial detail** (separation of duties); break-glass access only with reason + alert. |
| **Executive / Owner** | Read-only dashboards and reports; approves deals above Leasing Head's limits; PII masked by default. |
| **Leasing Head** | All properties; approves deal sheets, concessions, write-offs/credit memos (step 1), commission releases (step 1), deposit refunds (step 1); receives escalations. |
| **Leasing Manager** | Assigned properties: pipeline, contracts, billing review, **reminder worklist**, collections follow-up. |
| **Leasing Officer** | Assigned tenants only: activities, calls, documents, meter readings. |
| **Billing Officer** | Meter readings, billing runs (prepare), statements. Cannot approve own run. |
| **Property / Admin Officer** | Space status, move-in/out checklists, fit-out, maintenance requests. No financial detail. |
| **Finance / Accounting** | Payment posting, PDC vault, reconciliation, final approval of credit memos/refunds/commission payouts, withholding & 2307, exports. |
| **Compliance Officer / DPO** | Privacy requests, breach module, AML flags, audit logs, retention. Every PII view logged. |
| **Internal Auditor** | Read-only incl. audit logs; bulk PII export only with approval. |

### 7.2 External roles (portals — Phase 4)
| Role | Access |
|---|---|
| **Tenant Admin** | Manages their company's portal users; sees all their leases, bills, payments. |
| **Tenant User** | Permissions granted by Tenant Admin (e.g. billing only, maintenance only). |
| **Leasing Broker** | Own registered prospects, deals and commissions. |

### 7.3 Authorization model
- **RBAC + attribute-based rules** (property assignment, tenant assignment, broker firm). All scoping server-side; never trust client filters.
- Enforce in the application policy layer **and** PostgreSQL **Row-Level Security** (per-request session variables) as defense in depth.
- **Field-level permissions**: TINs, government ID numbers, bank accounts, tenant financial statements masked unless the role needs them; "reveal" requires a reason and is logged.
- **Maker–checker approvals** for: deal sheets outside limits, billing run issuance, credit memos/write-offs, payment reversals, deposit refunds, commission releases, bulk exports, role/permission changes. The preparer can never approve their own item.

### 7.4 Authentication
- Staff: OIDC SSO-ready (Google Workspace or Microsoft Entra **[CONFIRM]**) or local accounts; **MFA required** — passkeys/WebAuthn preferred, TOTP fallback; no SMS OTP for staff. Design identity so the future Residential Sales system can use the **same identity provider** (single sign-on, separate role sets per system).
- External users: email + password (Argon2id) with mandatory MFA (TOTP or email OTP) for brokers and tenant admins; step-up MFA for sensitive actions (downloads, changing contact/bank details).
- Passwords per NIST 800-63B (≥ 12 chars, breached-password check, no forced rotation); progressive lockout/backoff.
- Sessions: short-lived access (≤ 15 min) + rotating refresh tokens or server-side sessions; httpOnly, Secure, SameSite=Strict cookies; staff idle timeout 15 min, absolute 12 h; re-auth for sensitive actions; active-session list with remote revoke.
- Leaver process revokes all sessions immediately; quarterly access-review report.
- Optional IP allowlist for Admin and Finance roles.

---

## 8. Cybersecurity requirements (non-negotiable)

Target **OWASP ASVS Level 2** minimum; Level 3 controls for authentication, financial data and audit logging. Write a STRIDE threat model (`docs/security/threat-model.md`) in Phase 1 and keep it current.

### 8.1 Data protection
- TLS 1.2+ everywhere with HSTS. Encryption at rest for DB, backups and object storage.
- **Application-level envelope encryption** (cloud KMS) for TINs, government ID numbers, bank account numbers, tenant financials, scanned IDs and sensitive documents. Searchable encrypted fields use a keyed HMAC blind index. Key rotation supported.
- Documents in private object storage, served only via **short-lived signed URLs** (≤ 5 min) after an authorization check; every access logged.
- **Malware scan** all uploads; file-type allowlist; size limits; strip image metadata.
- No PII in logs, URLs, query strings, analytics or error trackers — redaction layer with tests proving it.
- Data minimisation; masked display by default.

### 8.2 Application security
- Schema validation on every endpoint; parameterised queries/ORM only; output encoding; strict Content-Security-Policy; CSRF protection; secure headers; CORS allowlist.
- Rate limiting per IP and per account on auth, OTP, search, export and file endpoints.
- IDOR protection: authorization on every object access; UUIDv7 external IDs; automated tests proving users cannot reach other properties'/tenants'/brokers' records.
- Bulk export controls: permission-gated, watermarked (user + time), size-capped, optionally approval-gated, alert on unusual volume.
- Secrets only in a secrets manager; pre-commit secret scanning.

### 8.3 Audit logging
- **Append-only, hash-chained audit log** for logins/failures, MFA changes, permission changes, PII reveals, document views/downloads, exports, every financial record change (before/after), approvals, config/rate changes.
- Shipped to a separate write-once store with restricted access.

### 8.4 Infrastructure
- Cloud region near PH (e.g. Singapore) **[CONFIRM provider]**; DB and cache in private subnets; no public DB endpoint; WAF + DDoS protection.
- Least-privilege IAM; production access via just-in-time, MFA-protected, logged sessions; no shared accounts.
- Separate dev/staging/prod; **no production data outside prod** — generated seed data; anonymised snapshots only with DPO approval.
- Infrastructure as code; minimal, scanned container images.

### 8.5 Backups & resilience
- Encrypted automated backups, point-in-time recovery, cross-region copy; **quarterly restore drills** documented. Target RPO ≤ 15 min, RTO ≤ 4 h **[CONFIRM]**.

### 8.6 Secure SDLC
- CI: lint, type-check, unit + integration tests, SAST, dependency scan (block high/critical), secret scan, container scan, DAST on staging before release.
- Mandatory code review; changes to auth, permissions, crypto or money logic flagged for extra review.
- Pinned dependencies with Renovate/Dependabot.
- Design for a **third-party penetration test** before go-live (I will arrange it).

### 8.7 Monitoring & detection
- Alerts on repeated failed logins, MFA resets, privilege escalation, mass record access/export, off-hours access by sensitive roles, new admin creation, audit logging disabled.
- Security dashboard for the Compliance Officer/DPO.

### 8.8 Privacy by design
- Versioned privacy notices and consent; purpose limitation per field group; retention jobs that anonymise/delete expired data (respecting legal holds); data-subject request workflow with SLA tracking.

### 8.9 Breach management module
- Incident register: detection time, "knowledge/reasonable belief" timestamp, affected records and data subjects (queryable from audit logs), severity, **72-hour countdown** to NPC and data-subject notification, 5-day full-report deadline, notification templates, actions taken. Runbook in `docs/security/incident-response.md`.

---

## 9. Architecture

### 9.1 Overall
A **modular monolith** (one deployable, strict module boundaries) — simpler to secure and operate than microservices at this scale.

- **Language:** TypeScript end to end.
- **Frontend:** Next.js (App Router) + React, Tailwind + shadcn/ui, TanStack Query, React Hook Form + Zod. Route groups for **Staff app**, and later **Tenant portal** and **Broker portal**, sharing a UI package.
- **Backend API:** NestJS (or Fastify with clear modules) — REST with an OpenAPI spec.
- **Database:** PostgreSQL 16+ with Row-Level Security; Prisma or Drizzle (choose the one that works cleanly with RLS session variables and justify it in an ADR). Money as `NUMERIC(14,2)` or integer centavos — **never floats**. Timestamps `timestamptz`; business dates in Asia/Manila.
- **Jobs/scheduler:** Redis + BullMQ for billing runs, escalation application, penalty computation, **reminder engine**, daily digests, license/document/lease-expiry alerts, retention jobs, scheduled reports. Jobs idempotent and logged.
- **Files:** S3-compatible private bucket + KMS; ClamAV (or equivalent) scanning worker.
- **PDFs:** server-side HTML→PDF (proposals, LOI, lease abstract, billing statements, SOAs, demand letters, deposit reconciliation).
- **Notifications:** pluggable email/SMS providers behind interfaces (local SMS options e.g. Semaphore, Globe/Smart APIs); in-app notification center.
- **Auth:** well-maintained library or IdP (e.g. Keycloak, Auth0, Cognito) supporting passkeys, TOTP and OIDC SSO — justify the choice in an ADR. Must be shareable with the future Residential Sales system.
- **Observability:** OpenTelemetry, structured JSON logs with redaction, PII-scrubbed error tracking, uptime checks.
- **Deployment:** Docker, Terraform, managed Postgres + Redis, CI/CD staging → production.
- **Local dev:** `docker compose up` runs everything with seed data.

### 9.2 Module boundaries
`identity` · `contacts` (companies, people, KYC) · `properties` (buildings, floors, spaces, meters) · `pipeline` (prospects, proposals, deal sheets) · `leases` (contracts, versions, critical dates) · `billing` (runs, statements, meter readings) · `receivables` (payments, allocations, PDCs, 2307, aging) · `reminders` (rules, tasks, worklist) · `brokers` & `commissions` · `operations` (move-in/out, fit-out, maintenance) · `compliance` (privacy, AML flags, retention, breach) · `documents` · `notifications` · `reporting` · `config` (rate tables with effective dates) · `audit`.

Modules communicate through service interfaces and domain events, never by reading each other's tables.

### 9.3 Future integration with the Residential Sales system
- Separate codebase and database. Shared: identity provider (SSO), design-system package (optional), and a **contacts API** so a person who is both a buyer and a tenant signatory can be linked later. Version the public API from day one (`/api/v1`).

---

## 10. Core data model (starting point — refine in plan mode)

- `Company`, `Person`, `CompanyContactRole` (signatory, billing contact, guarantor), `KycProfile` (encrypted fields), `Consent`.
- `Property`, `Building`, `Floor`, `Space`, `SpaceHistory` (splits/merges), `ParkingSlot`, `Meter`.
- `Prospect`, `ProspectTag` (broker ownership window), `Activity`, `Proposal`, `DealSheet`.
- `Lease`, `LeaseVersion`, `LeaseSpace`, `RentSchedule`, `EscalationRule`, `ChargeType`, `RecurringCharge`, `PercentageRentRule`, `CriticalDate`, `SecurityDeposit`, `DepositTransaction`.
- `MeterReading`, `TenantSalesReport`.
- `BillingRun`, `BillingStatement`, `BillingLine`, `Penalty`, `CreditMemo`.
- `Payment`, `PaymentAllocation`, `Check` (PDC), `PromiseToPay`, `Form2307Expected`, `Form2307Received`.
- `ReminderRule`, `ReminderTask`, `CallLog`, `Notification`, `DemandLetter`.
- `Broker`, `BrokerFirm`, `LicenseRecord`, `CommissionScheme`, `DealCommission`, `CommissionTranche`, `CommissionReleaseBatch`, `WithholdingRecord`.
- `MoveInChecklist`, `MoveOutChecklist`, `FitOut`, `WorkOrder`.
- `ApprovalRequest`.
- `DataSubjectRequest`, `SecurityIncident`, `AmlFlag`, `RetentionPolicy`, `LegalHold`.
- `TaxRateTable`, `ConfigValue` (with `effective_from` / `effective_to`).
- `AuditLog` (append-only, hash-chained).

Never edit posted financial records — reverse and re-post.

---

## 11. Engineering conventions (put in CLAUDE.md)

- Monorepo (pnpm workspaces / Turborepo): `apps/web`, `apps/api`, `apps/worker`, `packages/ui`, `packages/domain`, `packages/config`.
- Strict TypeScript, ESLint, Prettier; no `any` in domain code.
- **Tests**: table-driven unit tests for all money logic — rent schedules, escalations (incl. mid-month anniversaries), pro-rating, rent-free periods, holdover, CUSA, utilities, percentage rent, penalties, VAT, withholding, payment allocation, deposit reconciliation, commission computation. Edge cases: leap years, month-end due dates (e.g. 31st), partial payments, overpayments/advances, bounced checks, lease amendments mid-term, pre-termination. Integration tests for every permission rule (one test per role proving what it **cannot** access). ≥ 80% coverage on `packages/domain`.
- Reminder engine tested with a controllable clock (no real-time sleeps).
- Every migration reviewed; RLS policies covered by tests.
- Decimal library for money; rounding rules centralised.
- Feature flags: invoicing, online payments, portals, AI assist.
- Seed script: 1 company, 2 commercial buildings (one office, one retail), ~80 spaces, ~30 tenants in mixed states (current, overdue, expiring, in fit-out, moved out), 8 brokers, a year of billing and payment history including PDCs and a bounced check.
- `docs/`: ADRs, threat model, incident response runbook, data dictionary, user guide per role.

---

## 12. Delivery phases

**Phase 1 — Foundation & security** (no business features until this is solid)
Monorepo, CI with security scans, Docker dev env, auth with MFA/passkeys, RBAC + RLS, audit log, field encryption, document storage with signed URLs, config/rate tables with effective dates, companies/contacts/KYC, Excel import framework, threat model.

**Phase 2 — Spaces, pipeline & leases**
Property/space inventory with stacking plan, prospects + broker tagging, proposals, deal sheets with approvals, lease contracts with versions/escalations/charges/deposits, critical dates and expiry alerts, tenant compliance documents, move-in/fit-out checklists, data migration import of existing leases and opening balances.

**Phase 3 — Billing, receivables & reminders** (core value)
Meter readings, billing runs with approval, billing statements, payments & allocation, PDC vault, 2307 tracking, aging, **reminder engine + Today's Calls worklist + daily digest**, promises-to-pay, demand letters, broker commissions with maker–checker, dashboards (occupancy, WALE, rent roll, aging), cash-flow forecast, bank statement import, accounting export.

**Phase 4 — Portals & compliance depth**
Tenant portal, broker portal, online payments, e-signature, maintenance work orders, privacy-request and breach modules, retention jobs, report scheduler, move-out and deposit reconciliation workflow (if not already done).

Each phase ends with passing tests, updated docs, a seeded demo, and a short security checklist of the ASVS items touched.

---

## 13. Open decisions — ask me before implementing

1. Cloud provider/region; managed IdP vs. self-hosted (must be reusable by the Residential system).
2. Staff SSO: Google Workspace or Microsoft 365?
3. Accounting system for export; will this system ever issue BIR invoices?
4. CUSA basis and which tenants have percentage rent.
5. Payment allocation order.
6. Reminder offsets (defaults in §3.3) and whether reminders go directly to tenants.
7. Deal approval thresholds: which deal sizes or concessions need Executive approval on top of the Leasing Head.
8. Who bears documentary stamp tax on leases.
9. Retention periods per record type.
10. SMS provider and sender ID.

**Already decided:** deposit months, advance rent months, escalation, late-payment penalty and broker commission are **negotiated per deal**. They are per-lease (per-deal) fields with no company defaults (see §2.3 and §3.4). Do not add global settings for them.

Do **not** guess the remaining items. Use the defaults in this brief only for seed/demo data, and keep every one editable in config. The seed data should show a **variety** of negotiated terms across tenants, e.g. 2–6 months deposit, 0–10% escalations, different penalty types, and different commission bases.
