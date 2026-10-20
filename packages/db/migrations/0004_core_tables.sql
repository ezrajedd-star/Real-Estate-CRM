-- 0004 Phase 1 business-foundation tables: crypto keys, config/rates, approvals,
-- properties (scoping anchor), contacts/KYC/consent, documents, imports, exports.
-- Money columns are NUMERIC(14,2); rates NUMERIC(9,6); business dates are DATE (Asia/Manila).

------------------------------------------------------------------------------------------
-- crypto: wrapped data-encryption keys (ADR-005)
------------------------------------------------------------------------------------------
CREATE TABLE crypto.data_key (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  purpose     text NOT NULL CHECK (purpose ~ '^[a-z_]+$'),   -- tin, gov_id, bank, financials, import, blind_index
  version     integer NOT NULL CHECK (version > 0),
  kek_id      text NOT NULL,                                 -- KMS key ARN / local key id
  wrapped_key text NOT NULL,                                 -- base64 DEK encrypted by the KEK
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DECRYPT_ONLY', 'RETIRED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purpose, version)
);
CREATE UNIQUE INDEX data_key_one_active ON crypto.data_key (purpose) WHERE status = 'ACTIVE';

------------------------------------------------------------------------------------------
-- config: effective-dated configuration and tax-rate tables. Never edited in place:
-- a change closes the current row (effective_to) and inserts a new one, via approval.
------------------------------------------------------------------------------------------
CREATE TABLE config.config_value (
  id                  uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  key                 text NOT NULL CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  scope_type          text NOT NULL DEFAULT 'GLOBAL' CHECK (scope_type IN ('GLOBAL', 'PROPERTY', 'COMPANY')),
  scope_id            uuid,
  value               jsonb NOT NULL,
  effective_from      date NOT NULL,
  effective_to        date,
  needs_confirmation  boolean NOT NULL DEFAULT true,
  notes               text,
  approval_request_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES identity.app_user (id),
  CHECK ((scope_type = 'GLOBAL') = (scope_id IS NULL)),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (
    key WITH =,
    scope_type WITH =,
    (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE TABLE config.tax_rate (
  id                  uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tax_type            text NOT NULL CHECK (tax_type ~ '^[A-Z0-9_]+$'),  -- VAT, EWT_RENT, EWT_BROKER, DST_LEASE …
  rate                numeric(9, 6) CHECK (rate IS NULL OR (rate >= 0 AND rate <= 1)),
  brackets            jsonb,           -- for non-flat schedules (e.g. DST per ₱1,000 bands)
  basis               text NOT NULL,   -- plain-language description of what the rate applies to
  source_reference    text,            -- law / RR / RMC citation
  effective_from      date NOT NULL,
  effective_to        date,
  needs_confirmation  boolean NOT NULL DEFAULT true,
  approval_request_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES identity.app_user (id),
  CHECK ((rate IS NULL) <> (brackets IS NULL)),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (tax_type WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
);

CREATE TABLE config.feature_flag (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  description text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES identity.app_user (id)
);
INSERT INTO config.feature_flag (key, description) VALUES
  ('invoicing', 'Issue BIR invoices from this system. Enable only after BIR registration (EOPT Act).'),
  ('online_payments', 'Online payment gateway (Phase 4).'),
  ('portals', 'Tenant and broker portals (Phase 4).'),
  ('ai_assist', 'AI summaries/drafts. Requires a DPA and data minimisation before enabling.');

------------------------------------------------------------------------------------------
-- approvals: generic maker–checker engine
------------------------------------------------------------------------------------------
CREATE TABLE approvals.approval_request (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  type          text NOT NULL,
  subject_type  text,
  subject_id    text,
  summary       text NOT NULL,
  payload       jsonb NOT NULL,          -- what will be applied on approval (no clear-text PII)
  maker_id      uuid NOT NULL REFERENCES identity.app_user (id),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  applied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX approval_request_pending_idx ON approvals.approval_request (type, created_at) WHERE status = 'PENDING';
CREATE TRIGGER approval_request_touch BEFORE UPDATE ON approvals.approval_request
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE approvals.approval_decision (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  request_id  uuid NOT NULL REFERENCES approvals.approval_request (id),
  step_index  integer NOT NULL CHECK (step_index >= 0),
  decider_id  uuid NOT NULL REFERENCES identity.app_user (id),
  decision    text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  comment     text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, step_index),
  UNIQUE (request_id, decider_id)
);

-- Defense in depth for "the preparer can never approve their own item".
CREATE FUNCTION approvals.enforce_checker() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, approvals, app AS $$
DECLARE
  maker uuid;
BEGIN
  SELECT r.maker_id INTO maker FROM approvals.approval_request r WHERE r.id = NEW.request_id;
  IF NEW.decider_id = maker THEN
    RAISE EXCEPTION 'maker cannot approve their own request' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decider_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'decider must be the current user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approval_decision_checker BEFORE INSERT ON approvals.approval_decision
  FOR EACH ROW EXECUTE FUNCTION approvals.enforce_checker();
CREATE TRIGGER approval_decision_append_only BEFORE UPDATE OR DELETE ON approvals.approval_decision
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

------------------------------------------------------------------------------------------
-- properties: minimal anchor for property-scoped access (full inventory in Phase 2)
------------------------------------------------------------------------------------------
CREATE TABLE properties.property (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,20}$'),
  name        text NOT NULL,
  address     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES identity.app_user (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE TRIGGER property_touch BEFORE UPDATE ON properties.property FOR EACH ROW EXECUTE FUNCTION app.touch_row();

------------------------------------------------------------------------------------------
-- contacts: companies, people, roles, KYC, bank accounts, privacy notices and consent
------------------------------------------------------------------------------------------
CREATE TABLE contacts.company (
  id                 uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  legal_name         text NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 300),
  trade_name         text,
  registration_type  text NOT NULL CHECK (registration_type IN ('SEC', 'DTI', 'CDA', 'GOVERNMENT', 'FOREIGN', 'OTHER')),
  registration_no    text,
  tin_enc            text,              -- envelope-encrypted TIN
  tin_bidx           text,              -- HMAC blind index of the normalised TIN (dedupe/search)
  tin_last3          text CHECK (tin_last3 ~ '^\d{3}$'),  -- branch code, safe to display
  vat_status         text NOT NULL DEFAULT 'VAT' CHECK (vat_status IN ('VAT', 'NON_VAT', 'VAT_EXEMPT', 'ZERO_RATED')),
  registered_address text,
  industry           text,
  status             text NOT NULL DEFAULT 'PROSPECT' CHECK (status IN ('PROSPECT', 'TENANT', 'FORMER_TENANT', 'BLOCKED')),
  name_search        text GENERATED ALWAYS AS (lower(legal_name || ' ' || coalesce(trade_name, ''))) STORED,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES identity.app_user (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1,
  CHECK ((tin_enc IS NULL) = (tin_bidx IS NULL))
);
CREATE UNIQUE INDEX company_tin_bidx_uq ON contacts.company (tin_bidx) WHERE tin_bidx IS NOT NULL;
CREATE INDEX company_name_search_idx ON contacts.company (name_search);
CREATE TRIGGER company_touch BEFORE UPDATE ON contacts.company FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Which properties a company relates to (prospect for / tenant in). Drives property-scoped
-- visibility. Maintained by pipeline/leases from Phase 2; set manually or by import in Phase 1.
CREATE TABLE contacts.company_property (
  company_id   uuid NOT NULL REFERENCES contacts.company (id),
  property_id  uuid NOT NULL REFERENCES properties.property (id),
  relation     text NOT NULL DEFAULT 'PROSPECT' CHECK (relation IN ('PROSPECT', 'TENANT', 'FORMER_TENANT')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES identity.app_user (id),
  PRIMARY KEY (company_id, property_id)
);
CREATE INDEX company_property_property_idx ON contacts.company_property (property_id);

CREATE TABLE contacts.person (
  id             uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  full_name      text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 200),
  email          text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone          text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{7,20}$'),
  gov_id_type    text CHECK (gov_id_type IN ('PASSPORT', 'DRIVERS_LICENSE', 'UMID', 'PHILSYS', 'PRC', 'POSTAL', 'TIN', 'OTHER')),
  gov_id_enc     text,
  gov_id_bidx    text,
  gov_id_last4   text,
  nationality    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES identity.app_user (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1,
  CHECK ((gov_id_enc IS NULL) = (gov_id_bidx IS NULL))
);
CREATE INDEX person_email_idx ON contacts.person (lower(email));
CREATE TRIGGER person_touch BEFORE UPDATE ON contacts.person FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE contacts.company_contact_role (
  id                     uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid NOT NULL REFERENCES contacts.company (id),
  person_id              uuid NOT NULL REFERENCES contacts.person (id),
  role                   text NOT NULL CHECK (role IN ('SIGNATORY', 'BILLING_CONTACT', 'GUARANTOR', 'BENEFICIAL_OWNER', 'OPERATIONS_CONTACT', 'PRIMARY_CONTACT')),
  title                  text,
  authority_document_id  uuid,          -- board resolution / secretary's certificate
  ownership_pct          numeric(5, 2) CHECK (ownership_pct IS NULL OR (ownership_pct > 0 AND ownership_pct <= 100)),
  effective_from         date NOT NULL DEFAULT current_date,
  effective_to           date,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES identity.app_user (id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (role = 'BENEFICIAL_OWNER' OR ownership_pct IS NULL)
);
CREATE INDEX company_contact_role_company_idx ON contacts.company_contact_role (company_id);
CREATE INDEX company_contact_role_person_idx ON contacts.company_contact_role (person_id);

CREATE TABLE contacts.kyc_profile (
  id               uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid NOT NULL UNIQUE REFERENCES contacts.company (id),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  risk_rating      text CHECK (risk_rating IN ('LOW', 'MEDIUM', 'HIGH')),
  financials_enc   text,                -- encrypted summary of tenant financial statements
  notes            text,
  reviewed_by      uuid REFERENCES identity.app_user (id),
  reviewed_at      timestamptz,
  next_review_on   date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES identity.app_user (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1
);
CREATE TRIGGER kyc_profile_touch BEFORE UPDATE ON contacts.kyc_profile FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE contacts.bank_account (
  id               uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid NOT NULL REFERENCES contacts.company (id),
  bank_name        text NOT NULL,
  account_name     text NOT NULL,
  account_no_enc   text NOT NULL,
  account_no_bidx  text NOT NULL,
  account_no_last4 text NOT NULL CHECK (account_no_last4 ~ '^\d{4}$'),
  purpose          text NOT NULL DEFAULT 'REFUND' CHECK (purpose IN ('REFUND', 'OTHER')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES identity.app_user (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1
);
CREATE INDEX bank_account_company_idx ON contacts.bank_account (company_id);
CREATE TRIGGER bank_account_touch BEFORE UPDATE ON contacts.bank_account FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE contacts.privacy_notice (
  id              uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  version_label   text NOT NULL UNIQUE,
  audience        text NOT NULL CHECK (audience IN ('TENANT_CONTACT', 'BROKER', 'PROSPECT', 'STAFF')),
  title           text NOT NULL,
  body_markdown   text NOT NULL,
  body_sha256     text NOT NULL,
  effective_from  date NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  published_by    uuid REFERENCES identity.app_user (id)
);
CREATE TRIGGER privacy_notice_immutable BEFORE UPDATE OR DELETE ON contacts.privacy_notice
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- Consent / lawful-basis records are append-only; withdrawal is a new row.
CREATE TABLE contacts.consent (
  id             uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  person_id      uuid NOT NULL REFERENCES contacts.person (id),
  notice_id      uuid NOT NULL REFERENCES contacts.privacy_notice (id),
  purpose        text NOT NULL CHECK (purpose IN ('LEASE_ADMINISTRATION', 'BILLING_AND_COLLECTION', 'KYC_AML', 'MARKETING', 'TENANT_REMINDERS')),
  lawful_basis   text NOT NULL CHECK (lawful_basis IN ('CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'LEGITIMATE_INTEREST')),
  action         text NOT NULL CHECK (action IN ('GRANTED', 'WITHDRAWN', 'ACKNOWLEDGED')),
  channel        text NOT NULL CHECK (channel IN ('PAPER', 'EMAIL', 'PORTAL', 'IN_PERSON', 'IMPORT')),
  evidence_document_id uuid,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  captured_by    uuid REFERENCES identity.app_user (id)
);
CREATE INDEX consent_person_idx ON contacts.consent (person_id, purpose, captured_at);
CREATE TRIGGER consent_append_only BEFORE UPDATE OR DELETE ON contacts.consent
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

------------------------------------------------------------------------------------------
-- documents (ADR-006): metadata only; bytes live in a private bucket
------------------------------------------------------------------------------------------
CREATE TABLE documents.document (
  id               uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid REFERENCES contacts.company (id),   -- scope for access control
  owner_type       text NOT NULL,       -- e.g. company, person, kyc_profile, import_batch
  owner_id         uuid NOT NULL,
  category         text NOT NULL,       -- e.g. SEC_REGISTRATION, BOARD_RESOLUTION, GOV_ID, IMPORT_FILE
  classification   text NOT NULL DEFAULT 'GENERAL' CHECK (classification IN ('GENERAL', 'SENSITIVE')),
  original_name    text NOT NULL,
  content_type     text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  sha256           text,
  storage_key      text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'PENDING_UPLOAD'
                   CHECK (status IN ('PENDING_UPLOAD', 'QUARANTINED', 'CLEAN', 'INFECTED', 'REJECTED')),
  scan_detail      text,
  scanned_at       timestamptz,
  uploaded_by      uuid NOT NULL REFERENCES identity.app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1
);
CREATE INDEX document_owner_idx ON documents.document (owner_type, owner_id);
CREATE INDEX document_company_idx ON documents.document (company_id);
CREATE TRIGGER document_touch BEFORE UPDATE ON documents.document FOR EACH ROW EXECUTE FUNCTION app.touch_row();

------------------------------------------------------------------------------------------
-- imports: Excel import framework (upload → validate → preview → commit)
------------------------------------------------------------------------------------------
CREATE TABLE imports.import_batch (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  import_type   text NOT NULL,          -- companies, contacts (more in Phase 2)
  document_id   uuid NOT NULL REFERENCES documents.document (id),
  property_id   uuid REFERENCES properties.property (id),
  status        text NOT NULL DEFAULT 'UPLOADED'
                CHECK (status IN ('UPLOADED', 'VALIDATING', 'VALIDATED', 'COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED')),
  total_rows    integer NOT NULL DEFAULT 0,
  valid_rows    integer NOT NULL DEFAULT 0,
  error_rows    integer NOT NULL DEFAULT 0,
  failure       text,
  created_by    uuid NOT NULL REFERENCES identity.app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);
CREATE TRIGGER import_batch_touch BEFORE UPDATE ON imports.import_batch FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE imports.import_row (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  batch_id    uuid NOT NULL REFERENCES imports.import_batch (id),
  row_number  integer NOT NULL,
  data_enc    text NOT NULL,            -- the raw row may hold PII (TINs), so it is encrypted
  errors      jsonb NOT NULL DEFAULT '[]',  -- [{field, code, message}] — never echoes values
  target_id   uuid,
  UNIQUE (batch_id, row_number)
);

------------------------------------------------------------------------------------------
-- exports: approval-gated, watermarked bulk exports
------------------------------------------------------------------------------------------
CREATE TABLE exports.export_job (
  id                  uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  kind                text NOT NULL,
  filters             jsonb NOT NULL DEFAULT '{}',
  approval_request_id uuid NOT NULL REFERENCES approvals.approval_request (id),
  row_count           integer,
  watermark           text,
  requested_by        uuid NOT NULL REFERENCES identity.app_user (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  downloaded_at       timestamptz,
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
