-- 0002 Identity: staff users (mirrors Keycloak subjects), scoped role assignments,
-- role→permission catalogue (synced from packages/domain on every migrate), sessions,
-- break-glass grants and access reviews.

CREATE TABLE identity.app_user (
  id              uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  keycloak_sub    text NOT NULL UNIQUE,
  email           text NOT NULL,
  display_name    text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'LEFT')),
  is_system       boolean NOT NULL DEFAULT false,
  last_login_at   timestamptz,
  left_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX app_user_email_uq ON identity.app_user (lower(email));
CREATE TRIGGER app_user_touch BEFORE UPDATE ON identity.app_user FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- The worker acts as this well-known system user, so its actions are attributed in the audit log.
INSERT INTO identity.app_user (id, keycloak_sub, email, display_name, is_system)
VALUES ('00000000-0000-7000-8000-000000000001', 'system:worker', 'worker@system.invalid', 'System worker', true);

CREATE TABLE identity.role_permission (
  role        text NOT NULL,
  permission  text NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE TABLE identity.role_assignment (
  id                    uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  user_id               uuid NOT NULL REFERENCES identity.app_user (id),
  role                  text NOT NULL,
  scope_type            text NOT NULL CHECK (scope_type IN ('GLOBAL', 'PROPERTY', 'COMPANY')),
  scope_id              uuid,
  approval_request_id   uuid,
  granted_at            timestamptz NOT NULL DEFAULT now(),
  granted_by            uuid REFERENCES identity.app_user (id),
  revoked_at            timestamptz,
  revoked_by            uuid REFERENCES identity.app_user (id),
  CHECK ((scope_type = 'GLOBAL') = (scope_id IS NULL))
);
CREATE INDEX role_assignment_user_idx ON identity.role_assignment (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX role_assignment_active_uq
  ON identity.role_assignment (user_id, role, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'))
  WHERE revoked_at IS NULL;

-- Index of server-side sessions (the session data itself lives in Redis). Lets users see
-- and revoke their sessions, and lets the leaver process revoke everything at once.
CREATE TABLE identity.user_session (
  id              text PRIMARY KEY,            -- SHA-256 of the session id, never the id itself
  user_id         uuid NOT NULL REFERENCES identity.app_user (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  user_agent      text,
  ip_hash         text,
  amr             text[] NOT NULL DEFAULT '{}', -- authentication methods (e.g. webauthn, otp)
  revoked_at      timestamptz,
  revoked_reason  text
);
CREATE INDEX user_session_user_idx ON identity.user_session (user_id) WHERE revoked_at IS NULL;

CREATE TABLE identity.break_glass_grant (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  user_id     uuid NOT NULL REFERENCES identity.app_user (id),
  reason      text NOT NULL CHECK (length(reason) >= 15),
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '2 hours')
);

CREATE TABLE identity.access_review (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  period_label  text NOT NULL,                -- e.g. 2026-Q4
  generated_at  timestamptz NOT NULL DEFAULT now(),
  generated_by  uuid NOT NULL REFERENCES identity.app_user (id),
  snapshot      jsonb NOT NULL                -- users × roles × scopes at generation time
);

-- Just-in-time provisioning at login. Runs as the table owner because there is no
-- authenticated user yet; it can only create/refresh the caller's own row.
CREATE FUNCTION identity.upsert_login(p_sub text, p_email text, p_display_name text)
RETURNS TABLE (user_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, identity AS $$
BEGIN
  IF p_sub LIKE 'system:%' THEN
    RAISE EXCEPTION 'reserved subject' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  INSERT INTO identity.app_user AS u (keycloak_sub, email, display_name, last_login_at)
  VALUES (p_sub, p_email, p_display_name, now())
  ON CONFLICT (keycloak_sub) DO UPDATE
    SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, last_login_at = now()
  RETURNING u.id, u.status;
END;
$$;
REVOKE ALL ON FUNCTION identity.upsert_login(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.upsert_login(text, text, text) TO app_rw;
