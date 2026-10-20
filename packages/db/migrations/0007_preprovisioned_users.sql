-- 0007 Pre-provisioned staff: an administrator (or the seed) can create a user and grant
-- roles before the person's first login, using a placeholder subject `pending:<email>`.
-- At first login, the IdP's subject claims that row if the email matches. Only `pending:`
-- rows can be claimed — an existing linked account can never be taken over by email.
-- Emails are trusted because the realm only accepts verified Google Workspace identities
-- (trustEmail on the hosted-domain IdP) or admin-created local accounts.

CREATE OR REPLACE FUNCTION identity.upsert_login(p_sub text, p_email text, p_display_name text)
RETURNS TABLE (user_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, identity AS $$
BEGIN
  IF p_sub LIKE 'system:%' OR p_sub LIKE 'pending:%' THEN
    RAISE EXCEPTION 'reserved subject' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM identity.app_user u WHERE u.keycloak_sub = p_sub) THEN
    UPDATE identity.app_user u
       SET keycloak_sub = p_sub
     WHERE u.keycloak_sub LIKE 'pending:%' AND lower(u.email) = lower(p_email);
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

-- Pre-provisioning is an owner/migrator operation (seed, or an admin tool via maker–checker).
CREATE FUNCTION identity.preprovision_user(p_email text, p_display_name text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, identity AS $$
  INSERT INTO identity.app_user (keycloak_sub, email, display_name)
  VALUES ('pending:' || lower(p_email), lower(p_email), p_display_name)
  ON CONFLICT (keycloak_sub) DO UPDATE SET display_name = EXCLUDED.display_name
  RETURNING id
$$;
REVOKE ALL ON FUNCTION identity.preprovision_user(text, text) FROM PUBLIC;
