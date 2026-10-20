-- 0003 Audit: append-only, hash-chained audit log (ADR-004) + security alerts.
--
-- hash = sha256(prev_hash || '|' || canonical(row)). Every insert takes a transaction-level
-- advisory lock so the chain is strictly serial. UPDATE/DELETE/TRUNCATE are revoked from
-- every runtime role AND blocked by triggers. The actor, timestamp, request id and IP hash
-- are taken from the request context by the trigger — the caller cannot forge them.

CREATE TABLE audit.audit_log (
  seq           bigint PRIMARY KEY,
  id            uuid NOT NULL UNIQUE DEFAULT app.uuid_v7(),
  occurred_at   timestamptz NOT NULL,
  actor_id      uuid,
  actor_type    text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'ANONYMOUS')),
  action        text NOT NULL CHECK (action ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  subject_type  text,
  subject_id    text,
  outcome       text NOT NULL DEFAULT 'SUCCESS' CHECK (outcome IN ('SUCCESS', 'FAILURE', 'DENIED')),
  details       jsonb NOT NULL DEFAULT '{}',
  request_id    text,
  ip_hash       text,
  prev_hash     text NOT NULL,
  hash          text NOT NULL
);
CREATE SEQUENCE audit.audit_log_seq OWNED BY audit.audit_log.seq;
CREATE INDEX audit_log_subject_idx ON audit.audit_log (subject_type, subject_id);
CREATE INDEX audit_log_actor_idx ON audit.audit_log (actor_id, occurred_at);
CREATE INDEX audit_log_action_idx ON audit.audit_log (action, occurred_at);

CREATE FUNCTION audit.canonical(r audit.audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    r.seq::text,
    r.id::text,
    to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(r.actor_id::text, ''),
    r.actor_type,
    r.action,
    coalesce(r.subject_type, ''),
    coalesce(r.subject_id, ''),
    r.outcome,
    r.details::text,              -- jsonb text form is canonical (sorted keys, no whitespace variance)
    coalesce(r.request_id, ''),
    coalesce(r.ip_hash, ''))
$$;

CREATE FUNCTION audit.compute_hash(prev text, r audit.audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(prev || '|' || audit.canonical(r), 'sha256'), 'hex')
$$;

CREATE FUNCTION audit.chain_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, audit, app AS $$
DECLARE
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit.audit_log.chain'));

  NEW.seq := nextval('audit.audit_log_seq');
  NEW.id := coalesce(NEW.id, app.uuid_v7());
  NEW.occurred_at := clock_timestamp();
  NEW.actor_id := app.current_user_id();
  NEW.actor_type := CASE
    WHEN app.is_worker() THEN 'SYSTEM'
    WHEN NEW.actor_id IS NULL THEN 'ANONYMOUS'
    ELSE 'USER' END;
  NEW.request_id := app.current_request_id();
  NEW.ip_hash := app.current_ip_hash();

  SELECT a.hash INTO last_hash FROM audit.audit_log a ORDER BY a.seq DESC LIMIT 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.hash := audit.compute_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.chain_insert();
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- Recomputes the chain from `from_seq`. Returns the first broken row, or nothing if intact.
CREATE FUNCTION audit.verify_chain(from_seq bigint DEFAULT 0, max_rows integer DEFAULT 1000000)
RETURNS TABLE (broken_seq bigint, expected_hash text, stored_hash text, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, audit AS $$
DECLARE
  r audit.audit_log;
  prev text;
  expected_seq bigint;
BEGIN
  IF from_seq > 0 THEN
    SELECT a.hash INTO prev FROM audit.audit_log a WHERE a.seq < from_seq ORDER BY a.seq DESC LIMIT 1;
  END IF;
  prev := coalesce(prev, repeat('0', 64));
  expected_seq := NULL;
  FOR r IN SELECT * FROM audit.audit_log a WHERE a.seq >= from_seq ORDER BY a.seq LIMIT max_rows LOOP
    IF r.prev_hash <> prev THEN
      RETURN QUERY SELECT r.seq, prev, r.prev_hash, 'prev_hash does not match previous row';
      RETURN;
    END IF;
    IF audit.compute_hash(prev, r) <> r.hash THEN
      RETURN QUERY SELECT r.seq, audit.compute_hash(prev, r), r.hash, 'row content does not match its hash';
      RETURN;
    END IF;
    prev := r.hash;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION audit.verify_chain(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.verify_chain(bigint, integer) TO app_worker;

-- Tracks how far the log has been shipped to the write-once (Object Lock) bucket.
CREATE TABLE audit.ship_cursor (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seq        bigint NOT NULL DEFAULT 0,
  last_hash       text,
  last_object_key text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO audit.ship_cursor (id) VALUES (1);

-- Security monitoring (brief §8.7): alerts raised by the app and by detection jobs.
CREATE TABLE audit.security_alert (
  id               uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  kind             text NOT NULL,          -- e.g. BREAK_GLASS, FAILED_LOGIN_BURST, AUDIT_CHAIN_BROKEN
  severity         text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  subject_user_id  uuid REFERENCES identity.app_user (id),
  details          jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES identity.app_user (id)
);
CREATE INDEX security_alert_open_idx ON audit.security_alert (created_at) WHERE acknowledged_at IS NULL;

-- Row-change capture for sensitive tables: who changed what, with before/after values.
-- Trigger arguments name columns whose values must never be copied into the log
-- (ciphertext, blind indexes, contact PII) — for those only "changed" is recorded.
CREATE FUNCTION audit.capture_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, audit, app AS $$
DECLARE
  redact text[] := TG_ARGV;
  old_j jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  new_j jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  changes jsonb := '{}';
  k text;
  subject text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(coalesce(new_j, old_j)) LOOP
    CONTINUE WHEN k IN ('updated_at', 'version');
    IF TG_OP = 'UPDATE' AND (old_j -> k) IS NOT DISTINCT FROM (new_j -> k) THEN
      CONTINUE;
    END IF;
    IF k = ANY (redact) OR k LIKE '%\_enc' OR k LIKE '%\_bidx' THEN
      changes := changes || jsonb_build_object(k, jsonb_build_object('changed', true));
    ELSE
      changes := changes || jsonb_build_object(k, jsonb_build_object('before', old_j -> k, 'after', new_j -> k));
    END IF;
  END LOOP;

  IF TG_OP = 'UPDATE' AND changes = '{}' THEN
    RETURN NEW;
  END IF;

  subject := coalesce(new_j ->> 'id', old_j ->> 'id');
  INSERT INTO audit.audit_log (action, subject_type, subject_id, details, actor_type, prev_hash, hash)
  VALUES ('row.' || lower(TG_OP), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, subject,
          jsonb_build_object('changes', changes), 'USER', '', '');
  RETURN coalesce(NEW, OLD);
END;
$$;
