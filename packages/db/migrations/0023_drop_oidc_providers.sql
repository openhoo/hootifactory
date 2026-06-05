DO $$
BEGIN
  IF to_regclass('public.oidc_providers') IS NOT NULL THEN
    IF to_regclass('public.legacy_oidc_providers_retained') IS NOT NULL THEN
      RAISE EXCEPTION 'legacy_oidc_providers_retained already exists; refusing to overwrite retained OIDC provider data';
    END IF;
    ALTER TABLE "oidc_providers" RENAME TO "legacy_oidc_providers_retained";
  END IF;
END $$;
