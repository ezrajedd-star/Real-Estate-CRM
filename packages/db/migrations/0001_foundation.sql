-- 0001 Foundation: schemas, UUIDv7, request-context helpers, housekeeping triggers.
-- Extensions pgcrypto and btree_gist are created by the bootstrap script (superuser).

CREATE SCHEMA app;          -- helper functions shared by policies
CREATE SCHEMA identity;
CREATE SCHEMA audit;
CREATE SCHEMA crypto;
CREATE SCHEMA config;
CREATE SCHEMA approvals;
CREATE SCHEMA properties;
CREATE SCHEMA contacts;
CREATE SCHEMA documents;
CREATE SCHEMA imports;
CREATE SCHEMA exports;

GRANT USAGE ON SCHEMA app, identity, audit, crypto, config, approvals, properties, contacts,
  documents, imports, exports TO app_rw, app_worker;

-- UUIDv7: 48-bit Unix-ms timestamp + random bits (RFC 9562). Time-ordered, not guessable.
CREATE FUNCTION app.uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
        PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
        FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- Request context. The API sets these with set_config(..., true) at the start of every
-- request transaction, so they vanish at COMMIT/ROLLBACK and never leak across pooled
-- connections.
CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_request_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.request_id', true), '')
$$;

CREATE FUNCTION app.current_ip_hash() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.ip_hash', true), '')
$$;

-- True only for the worker's own database role; a session variable cannot fake it.
CREATE FUNCTION app.is_worker() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT session_user = 'app_worker'
$$;

-- updated_at + optimistic-lock version bump.
CREATE FUNCTION app.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- Generic guard for append-only tables.
CREATE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rw, app_worker;
