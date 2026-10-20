-- 0005 Row-Level Security (ADR-003) — defense in depth behind the API policy layer.
--
-- The runtime roles (app_rw, app_worker) are not table owners and have NOBYPASSRLS, so every
-- statement they run is filtered here. Policies read the caller from `app.user_id`, which
-- the API sets per request transaction, and evaluate permissions/scopes from
-- identity.role_assignment × identity.role_permission. With no user set, nothing is visible.

------------------------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so they can read identity tables regardless of RLS)
------------------------------------------------------------------------------------------
CREATE FUNCTION app.user_is_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity, app AS $$
  SELECT EXISTS (SELECT 1 FROM identity.app_user u WHERE u.id = app.current_user_id() AND u.status = 'ACTIVE')
$$;

CREATE FUNCTION app.has_permission(p text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity, app AS $$
  SELECT app.user_is_active() AND EXISTS (
    SELECT 1 FROM identity.role_assignment ra
    JOIN identity.role_permission rp ON rp.role = ra.role
    WHERE ra.user_id = app.current_user_id() AND ra.revoked_at IS NULL AND rp.permission = p)
$$;

CREATE FUNCTION app.has_global_permission(p text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity, app AS $$
  SELECT app.user_is_active() AND EXISTS (
    SELECT 1 FROM identity.role_assignment ra
    JOIN identity.role_permission rp ON rp.role = ra.role
    WHERE ra.user_id = app.current_user_id() AND ra.revoked_at IS NULL AND rp.permission = p
      AND ra.scope_type = 'GLOBAL')
$$;

-- An active, unexpired break-glass grant for the current user (who must hold break_glass.use).
CREATE FUNCTION app.break_glass_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity, app AS $$
  SELECT app.has_permission('break_glass.use') AND EXISTS (
    SELECT 1 FROM identity.break_glass_grant g
    WHERE g.user_id = app.current_user_id() AND g.ended_at IS NULL AND now() < g.expires_at)
$$;

CREATE FUNCTION app.can_access_property(pid uuid, p text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity, app AS $$
  SELECT app.user_is_active() AND EXISTS (
    SELECT 1 FROM identity.role_assignment ra
    JOIN identity.role_permission rp ON rp.role = ra.role
    WHERE ra.user_id = app.current_user_id() AND ra.revoked_at IS NULL AND rp.permission = p
      AND (ra.scope_type = 'GLOBAL' OR (ra.scope_type = 'PROPERTY' AND ra.scope_id = pid)))
$$;

-- Company scope: GLOBAL grant, a COMPANY grant for this company, or a PROPERTY grant for a
-- property the company is linked to. Break-glass gives read-only visibility.
CREATE FUNCTION app.can_access_company(cid uuid, p text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity, contacts, app AS $$
  SELECT app.user_is_active() AND (
    EXISTS (
      SELECT 1 FROM identity.role_assignment ra
      JOIN identity.role_permission rp ON rp.role = ra.role
      WHERE ra.user_id = app.current_user_id() AND ra.revoked_at IS NULL AND rp.permission = p
        AND (ra.scope_type = 'GLOBAL'
          OR (ra.scope_type = 'COMPANY' AND ra.scope_id = cid)
          OR (ra.scope_type = 'PROPERTY' AND EXISTS (
                SELECT 1 FROM contacts.company_property cp
                WHERE cp.company_id = cid AND cp.property_id = ra.scope_id))))
    OR (p LIKE '%.read' AND app.break_glass_active()))
$$;

-- A person is visible through any company they hold a role in; a person not yet linked to
-- any company is visible only to its creator and to holders of a GLOBAL grant.
CREATE FUNCTION app.can_access_person(pid uuid, p text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity, contacts, app AS $$
  SELECT app.has_global_permission(p)
    OR (p LIKE '%.read' AND app.break_glass_active())
    OR EXISTS (SELECT 1 FROM contacts.company_contact_role r
               WHERE r.person_id = pid AND app.can_access_company(r.company_id, p))
    OR (app.has_permission(p) AND NOT EXISTS (SELECT 1 FROM contacts.company_contact_role r WHERE r.person_id = pid)
        AND EXISTS (SELECT 1 FROM contacts.person x WHERE x.id = pid AND x.created_by = app.current_user_id()))
$$;

-- A company the current user just created and has not yet linked to any property. Lets a
-- property-scoped user create a company and link it to their property in one transaction.
CREATE FUNCTION app.is_own_unlinked_company(cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, contacts, app AS $$
  SELECT EXISTS (SELECT 1 FROM contacts.company c
                 WHERE c.id = cid AND c.created_by = app.current_user_id()
                   AND NOT EXISTS (SELECT 1 FROM contacts.company_property x WHERE x.company_id = c.id))
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rw, app_worker;

------------------------------------------------------------------------------------------
-- Table privileges (coarse) — RLS (fine) below. No DELETE anywhere in Phase 1:
-- records are closed, revoked or superseded, never removed by the app.
------------------------------------------------------------------------------------------
GRANT SELECT ON identity.app_user, identity.role_permission, identity.role_assignment,
  identity.user_session, identity.break_glass_grant, identity.access_review TO app_rw;
GRANT UPDATE (status, left_at) ON identity.app_user TO app_rw;
GRANT INSERT ON identity.role_assignment, identity.user_session, identity.break_glass_grant, identity.access_review TO app_rw;
GRANT UPDATE (revoked_at, revoked_by) ON identity.role_assignment TO app_rw;
GRANT UPDATE (last_seen_at, idle_expires_at, revoked_at, revoked_reason) ON identity.user_session TO app_rw;
GRANT UPDATE (ended_at) ON identity.break_glass_grant TO app_rw;

GRANT SELECT, INSERT ON audit.audit_log TO app_rw, app_worker;
GRANT USAGE ON SEQUENCE audit.audit_log_seq TO app_rw, app_worker;
GRANT SELECT, INSERT ON audit.security_alert TO app_rw, app_worker;
GRANT UPDATE (acknowledged_at, acknowledged_by) ON audit.security_alert TO app_rw;
GRANT SELECT, UPDATE ON audit.ship_cursor TO app_worker;

GRANT SELECT ON crypto.data_key TO app_rw, app_worker;
GRANT INSERT, UPDATE (status) ON crypto.data_key TO app_worker;
-- First-use key creation from the API (when no key exists yet for a purpose).
GRANT INSERT ON crypto.data_key TO app_rw;

GRANT SELECT ON config.config_value, config.tax_rate, config.feature_flag TO app_rw, app_worker;
GRANT INSERT ON config.config_value, config.tax_rate TO app_rw;
GRANT UPDATE (effective_to) ON config.config_value, config.tax_rate TO app_rw;
GRANT UPDATE (enabled, updated_at, updated_by) ON config.feature_flag TO app_rw;

GRANT SELECT, INSERT ON approvals.approval_request, approvals.approval_decision TO app_rw;
GRANT UPDATE (status, decided_at, applied_at, updated_at, version) ON approvals.approval_request TO app_rw;

GRANT SELECT, INSERT, UPDATE ON properties.property TO app_rw;
GRANT SELECT ON properties.property TO app_worker;

GRANT SELECT, INSERT, UPDATE ON contacts.company, contacts.person, contacts.kyc_profile, contacts.bank_account TO app_rw;
GRANT SELECT, INSERT ON contacts.company_property, contacts.privacy_notice, contacts.consent TO app_rw;
GRANT SELECT, INSERT ON contacts.company_contact_role TO app_rw;
GRANT UPDATE (effective_to) ON contacts.company_contact_role TO app_rw;
GRANT UPDATE (relation) ON contacts.company_property TO app_rw;
GRANT SELECT, INSERT, UPDATE ON contacts.company, contacts.person TO app_worker;  -- re-encryption on key rotation
GRANT SELECT, UPDATE ON contacts.bank_account, contacts.kyc_profile TO app_worker;

GRANT SELECT, INSERT, UPDATE ON documents.document TO app_rw;
GRANT SELECT, UPDATE ON documents.document TO app_worker;

GRANT SELECT, INSERT, UPDATE ON imports.import_batch, imports.import_row TO app_rw;
GRANT SELECT, UPDATE ON imports.import_batch, imports.import_row TO app_worker;

GRANT SELECT, INSERT, UPDATE ON exports.export_job TO app_rw;

------------------------------------------------------------------------------------------
-- Enable RLS everywhere the runtime roles can reach
------------------------------------------------------------------------------------------
ALTER TABLE identity.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.user_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.break_glass_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.access_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.security_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.ship_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto.data_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE config.config_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE config.tax_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE config.feature_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals.approval_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals.approval_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties.property ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts.company ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts.company_property ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts.person ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts.company_contact_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts.kyc_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts.bank_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts.privacy_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts.consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports.import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports.import_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports.export_job ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------------------------------------
-- identity
------------------------------------------------------------------------------------------
CREATE POLICY own_or_user_read ON identity.app_user FOR SELECT TO app_rw
  USING (id = app.current_user_id() OR app.has_permission('user.read'));
CREATE POLICY leaver ON identity.app_user FOR UPDATE TO app_rw
  USING (app.has_permission('user.revoke_sessions')) WITH CHECK (app.has_permission('user.revoke_sessions'));

CREATE POLICY readable ON identity.role_permission FOR SELECT TO app_rw USING (app.current_user_id() IS NOT NULL);

CREATE POLICY own_or_user_read ON identity.role_assignment FOR SELECT TO app_rw
  USING (user_id = app.current_user_id() OR app.has_permission('user.read'));
-- Role changes are applied by the approving checker (maker–checker) — never self-granted.
CREATE POLICY approved_grant ON identity.role_assignment FOR INSERT TO app_rw
  WITH CHECK (app.has_permission('user.approve_role_change') AND user_id <> app.current_user_id());
CREATE POLICY approved_revoke ON identity.role_assignment FOR UPDATE TO app_rw
  USING (app.has_permission('user.approve_role_change') OR app.has_permission('user.revoke_sessions'))
  WITH CHECK (app.has_permission('user.approve_role_change') OR app.has_permission('user.revoke_sessions'));

CREATE POLICY own_or_admin ON identity.user_session FOR SELECT TO app_rw
  USING (user_id = app.current_user_id() OR app.has_permission('user.revoke_sessions'));
CREATE POLICY own_insert ON identity.user_session FOR INSERT TO app_rw
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY own_or_admin_update ON identity.user_session FOR UPDATE TO app_rw
  USING (user_id = app.current_user_id() OR app.has_permission('user.revoke_sessions'))
  WITH CHECK (user_id = app.current_user_id() OR app.has_permission('user.revoke_sessions'));

CREATE POLICY own_or_security ON identity.break_glass_grant FOR SELECT TO app_rw
  USING (user_id = app.current_user_id() OR app.has_permission('security.dashboard'));
CREATE POLICY own_with_permission ON identity.break_glass_grant FOR INSERT TO app_rw
  WITH CHECK (user_id = app.current_user_id() AND app.has_permission('break_glass.use'));
CREATE POLICY own_end ON identity.break_glass_grant FOR UPDATE TO app_rw
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

CREATE POLICY reviewers ON identity.access_review FOR SELECT TO app_rw USING (app.has_permission('access_review.run') OR app.has_permission('audit.read'));
CREATE POLICY reviewers_insert ON identity.access_review FOR INSERT TO app_rw
  WITH CHECK (app.has_permission('access_review.run') AND generated_by = app.current_user_id());

------------------------------------------------------------------------------------------
-- audit
------------------------------------------------------------------------------------------
CREATE POLICY anyone_appends ON audit.audit_log FOR INSERT TO app_rw, app_worker WITH CHECK (true);
CREATE POLICY auditors_read ON audit.audit_log FOR SELECT TO app_rw USING (app.has_permission('audit.read'));
CREATE POLICY worker_reads ON audit.audit_log FOR SELECT TO app_worker USING (true);

CREATE POLICY anyone_raises ON audit.security_alert FOR INSERT TO app_rw, app_worker WITH CHECK (true);
CREATE POLICY security_reads ON audit.security_alert FOR SELECT TO app_rw USING (app.has_permission('security.dashboard'));
CREATE POLICY worker_reads ON audit.security_alert FOR SELECT TO app_worker USING (true);
CREATE POLICY security_acks ON audit.security_alert FOR UPDATE TO app_rw
  USING (app.has_permission('security.dashboard')) WITH CHECK (app.has_permission('security.dashboard'));

CREATE POLICY worker_only ON audit.ship_cursor FOR ALL TO app_worker USING (true) WITH CHECK (true);

------------------------------------------------------------------------------------------
-- crypto: wrapped keys are useless without the KEK, but still limited to the runtime roles
------------------------------------------------------------------------------------------
CREATE POLICY runtime_reads ON crypto.data_key FOR SELECT TO app_rw, app_worker USING (true);
CREATE POLICY first_use_create ON crypto.data_key FOR INSERT TO app_rw
  WITH CHECK (version = 1 AND status = 'ACTIVE');
CREATE POLICY worker_manages ON crypto.data_key FOR INSERT TO app_worker WITH CHECK (true);
CREATE POLICY worker_rotates ON crypto.data_key FOR UPDATE TO app_worker USING (true) WITH CHECK (true);

------------------------------------------------------------------------------------------
-- config (writes only by an approving checker; see ConfigService)
------------------------------------------------------------------------------------------
CREATE POLICY readers ON config.config_value FOR SELECT TO app_rw USING (app.has_permission('config.read'));
CREATE POLICY worker_reads ON config.config_value FOR SELECT TO app_worker USING (true);
CREATE POLICY approver_inserts ON config.config_value FOR INSERT TO app_rw WITH CHECK (app.has_permission('config.approve'));
CREATE POLICY approver_closes ON config.config_value FOR UPDATE TO app_rw
  USING (app.has_permission('config.approve')) WITH CHECK (app.has_permission('config.approve'));

CREATE POLICY readers ON config.tax_rate FOR SELECT TO app_rw USING (app.has_permission('config.read'));
CREATE POLICY worker_reads ON config.tax_rate FOR SELECT TO app_worker USING (true);
CREATE POLICY approver_inserts ON config.tax_rate FOR INSERT TO app_rw WITH CHECK (app.has_permission('config.approve'));
CREATE POLICY approver_closes ON config.tax_rate FOR UPDATE TO app_rw
  USING (app.has_permission('config.approve')) WITH CHECK (app.has_permission('config.approve'));

CREATE POLICY staff_reads ON config.feature_flag FOR SELECT TO app_rw USING (app.user_is_active());
CREATE POLICY worker_reads ON config.feature_flag FOR SELECT TO app_worker USING (true);
CREATE POLICY approver_toggles ON config.feature_flag FOR UPDATE TO app_rw
  USING (app.has_permission('config.approve')) WITH CHECK (app.has_permission('config.approve'));

------------------------------------------------------------------------------------------
-- approvals
------------------------------------------------------------------------------------------
CREATE POLICY involved_reads ON approvals.approval_request FOR SELECT TO app_rw
  USING (maker_id = app.current_user_id() OR app.has_permission('approval.read')
         OR (type = 'ROLE_CHANGE' AND app.has_permission('user.approve_role_change'))
         OR (type = 'CONFIG_CHANGE' AND app.has_permission('config.approve'))
         OR (type = 'BULK_EXPORT' AND app.has_permission('export.approve')));
CREATE POLICY maker_creates ON approvals.approval_request FOR INSERT TO app_rw
  WITH CHECK (maker_id = app.current_user_id() AND status = 'PENDING');
CREATE POLICY involved_updates ON approvals.approval_request FOR UPDATE TO app_rw
  USING (maker_id = app.current_user_id()
         OR (type = 'ROLE_CHANGE' AND app.has_permission('user.approve_role_change'))
         OR (type = 'CONFIG_CHANGE' AND app.has_permission('config.approve'))
         OR (type = 'BULK_EXPORT' AND app.has_permission('export.approve')))
  WITH CHECK (true);

CREATE POLICY readers ON approvals.approval_decision FOR SELECT TO app_rw
  USING (EXISTS (SELECT 1 FROM approvals.approval_request r WHERE r.id = request_id));
CREATE POLICY checker_decides ON approvals.approval_decision FOR INSERT TO app_rw
  WITH CHECK (decider_id = app.current_user_id());

------------------------------------------------------------------------------------------
-- properties
------------------------------------------------------------------------------------------
CREATE POLICY scoped_read ON properties.property FOR SELECT TO app_rw USING (app.can_access_property(id, 'property.read'));
CREATE POLICY worker_reads ON properties.property FOR SELECT TO app_worker USING (true);
CREATE POLICY global_write ON properties.property FOR INSERT TO app_rw WITH CHECK (app.has_global_permission('property.write'));
CREATE POLICY scoped_update ON properties.property FOR UPDATE TO app_rw
  USING (app.can_access_property(id, 'property.write')) WITH CHECK (app.can_access_property(id, 'property.write'));

------------------------------------------------------------------------------------------
-- contacts
------------------------------------------------------------------------------------------
CREATE POLICY scoped_read ON contacts.company FOR SELECT TO app_rw USING (app.can_access_company(id, 'company.read'));
-- A new company is linked to a property in the same transaction (see ContactsService),
-- so scoped users must use client-generated ids rather than INSERT … RETURNING.
CREATE POLICY writers_insert ON contacts.company FOR INSERT TO app_rw
  WITH CHECK (app.has_permission('company.write') AND created_by = app.current_user_id());
CREATE POLICY scoped_update ON contacts.company FOR UPDATE TO app_rw
  USING (app.can_access_company(id, 'company.write')) WITH CHECK (app.can_access_company(id, 'company.write'));
CREATE POLICY worker_all ON contacts.company FOR ALL TO app_worker USING (true) WITH CHECK (true);

CREATE POLICY scoped_read ON contacts.company_property FOR SELECT TO app_rw
  USING (app.can_access_company(company_id, 'company.read') OR app.can_access_property(property_id, 'company.read'));
CREATE POLICY scoped_link ON contacts.company_property FOR INSERT TO app_rw
  WITH CHECK (app.can_access_property(property_id, 'company.write')
              AND (app.can_access_company(company_id, 'company.write') OR app.is_own_unlinked_company(company_id)));
CREATE POLICY scoped_relink ON contacts.company_property FOR UPDATE TO app_rw
  USING (app.can_access_property(property_id, 'company.write')) WITH CHECK (app.can_access_property(property_id, 'company.write'));

CREATE POLICY scoped_read ON contacts.person FOR SELECT TO app_rw USING (app.can_access_person(id, 'contact.read'));
CREATE POLICY writers_insert ON contacts.person FOR INSERT TO app_rw
  WITH CHECK (app.has_permission('contact.write') AND created_by = app.current_user_id());
CREATE POLICY scoped_update ON contacts.person FOR UPDATE TO app_rw
  USING (app.can_access_person(id, 'contact.write')) WITH CHECK (app.can_access_person(id, 'contact.write'));
CREATE POLICY worker_all ON contacts.person FOR ALL TO app_worker USING (true) WITH CHECK (true);

CREATE POLICY scoped_read ON contacts.company_contact_role FOR SELECT TO app_rw USING (app.can_access_company(company_id, 'contact.read'));
CREATE POLICY scoped_write ON contacts.company_contact_role FOR INSERT TO app_rw WITH CHECK (app.can_access_company(company_id, 'contact.write'));
CREATE POLICY scoped_end ON contacts.company_contact_role FOR UPDATE TO app_rw
  USING (app.can_access_company(company_id, 'contact.write')) WITH CHECK (app.can_access_company(company_id, 'contact.write'));

CREATE POLICY scoped_read ON contacts.kyc_profile FOR SELECT TO app_rw USING (app.can_access_company(company_id, 'kyc.read'));
CREATE POLICY scoped_write ON contacts.kyc_profile FOR INSERT TO app_rw WITH CHECK (app.can_access_company(company_id, 'kyc.write'));
CREATE POLICY scoped_update ON contacts.kyc_profile FOR UPDATE TO app_rw
  USING (app.can_access_company(company_id, 'kyc.write')) WITH CHECK (app.can_access_company(company_id, 'kyc.write'));
CREATE POLICY worker_all ON contacts.kyc_profile FOR ALL TO app_worker USING (true) WITH CHECK (true);

-- Bank details are financial data: KYC readers only (Property Officers never see them).
CREATE POLICY scoped_read ON contacts.bank_account FOR SELECT TO app_rw USING (app.can_access_company(company_id, 'kyc.read'));
CREATE POLICY scoped_write ON contacts.bank_account FOR INSERT TO app_rw WITH CHECK (app.can_access_company(company_id, 'kyc.write'));
CREATE POLICY scoped_update ON contacts.bank_account FOR UPDATE TO app_rw
  USING (app.can_access_company(company_id, 'kyc.write')) WITH CHECK (app.can_access_company(company_id, 'kyc.write'));
CREATE POLICY worker_all ON contacts.bank_account FOR ALL TO app_worker USING (true) WITH CHECK (true);

CREATE POLICY staff_reads ON contacts.privacy_notice FOR SELECT TO app_rw USING (app.user_is_active());
CREATE POLICY dpo_publishes ON contacts.privacy_notice FOR INSERT TO app_rw
  WITH CHECK (app.has_permission('privacy.manage') AND published_by = app.current_user_id());

CREATE POLICY scoped_read ON contacts.consent FOR SELECT TO app_rw USING (app.can_access_person(person_id, 'contact.read'));
CREATE POLICY scoped_capture ON contacts.consent FOR INSERT TO app_rw
  WITH CHECK (app.has_permission('consent.write') AND app.can_access_person(person_id, 'contact.read')
              AND captured_by = app.current_user_id());

------------------------------------------------------------------------------------------
-- documents
------------------------------------------------------------------------------------------
CREATE POLICY scoped_read ON documents.document FOR SELECT TO app_rw USING (
  (company_id IS NULL AND (uploaded_by = app.current_user_id() OR app.has_global_permission('document.read')))
  OR (company_id IS NOT NULL AND app.can_access_company(company_id, 'document.read')
      AND (classification = 'GENERAL' OR app.can_access_company(company_id, 'document.read_sensitive'))));
CREATE POLICY uploader_inserts ON documents.document FOR INSERT TO app_rw
  WITH CHECK (app.has_permission('document.upload') AND uploaded_by = app.current_user_id()
              AND status = 'PENDING_UPLOAD'
              AND (company_id IS NULL OR app.can_access_company(company_id, 'document.upload')));
-- The uploader can only move PENDING_UPLOAD → QUARANTINED; only the worker can mark CLEAN.
CREATE POLICY uploader_confirms ON documents.document FOR UPDATE TO app_rw
  USING (uploaded_by = app.current_user_id() AND status = 'PENDING_UPLOAD')
  WITH CHECK (status IN ('QUARANTINED', 'REJECTED'));
CREATE POLICY worker_scans ON documents.document FOR ALL TO app_worker USING (true) WITH CHECK (true);

------------------------------------------------------------------------------------------
-- imports / exports: owner-only, plus GLOBAL import.run holders
------------------------------------------------------------------------------------------
CREATE POLICY owner_or_global ON imports.import_batch FOR SELECT TO app_rw
  USING (created_by = app.current_user_id() OR app.has_global_permission('import.run'));
CREATE POLICY runner_creates ON imports.import_batch FOR INSERT TO app_rw
  WITH CHECK (app.has_permission('import.run') AND created_by = app.current_user_id());
CREATE POLICY owner_updates ON imports.import_batch FOR UPDATE TO app_rw
  USING (created_by = app.current_user_id()) WITH CHECK (created_by = app.current_user_id());
CREATE POLICY worker_all ON imports.import_batch FOR ALL TO app_worker USING (true) WITH CHECK (true);

CREATE POLICY via_batch ON imports.import_row FOR ALL TO app_rw
  USING (EXISTS (SELECT 1 FROM imports.import_batch b WHERE b.id = batch_id))
  WITH CHECK (EXISTS (SELECT 1 FROM imports.import_batch b WHERE b.id = batch_id AND b.created_by = app.current_user_id()));
CREATE POLICY worker_all ON imports.import_row FOR ALL TO app_worker USING (true) WITH CHECK (true);

CREATE POLICY requester ON exports.export_job FOR SELECT TO app_rw
  USING (requested_by = app.current_user_id() OR app.has_permission('export.approve'));
CREATE POLICY requester_creates ON exports.export_job FOR INSERT TO app_rw
  WITH CHECK (requested_by = app.current_user_id() AND app.has_permission('export.request'));
CREATE POLICY requester_downloads ON exports.export_job FOR UPDATE TO app_rw
  USING (requested_by = app.current_user_id()) WITH CHECK (requested_by = app.current_user_id());

------------------------------------------------------------------------------------------
-- Row-change audit on sensitive tables (contact PII values redacted; *_enc/_bidx always)
------------------------------------------------------------------------------------------
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON identity.role_assignment FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER UPDATE ON identity.app_user FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('email');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON identity.break_glass_grant FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON config.config_value FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON config.tax_rate FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER UPDATE ON config.feature_flag FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON approvals.approval_request FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('payload');
CREATE TRIGGER audit_row AFTER INSERT ON approvals.approval_decision FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON contacts.company FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON contacts.person FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('email', 'phone', 'full_name', 'gov_id_last4');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON contacts.company_contact_role FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON contacts.kyc_profile FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('notes');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON contacts.bank_account FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('account_name');
CREATE TRIGGER audit_row AFTER INSERT ON contacts.consent FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON documents.document FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('original_name');
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON properties.property FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();
