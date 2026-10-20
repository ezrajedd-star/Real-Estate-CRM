-- 0006 Global TIN duplicate check for imports.
-- The unique index on contacts.company.tin_bidx is global, but RLS hides companies outside
-- the caller's scope. This function answers only "which of these blind indexes are already
-- registered" — no ids, names or other columns — so import validation can flag duplicates
-- before commit. It reveals no more than the unique-violation error on insert already does.

CREATE FUNCTION contacts.existing_tin_bidx(candidates text[]) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, contacts, app AS $$
  SELECT c.tin_bidx FROM contacts.company c
  WHERE app.has_permission('import.run') AND c.tin_bidx = ANY (candidates)
$$;
REVOKE ALL ON FUNCTION contacts.existing_tin_bidx(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contacts.existing_tin_bidx(text[]) TO app_rw;
