DO $$
BEGIN
  IF to_regclass('public.sbom_components') IS NOT NULL THEN
    IF to_regclass('public.legacy_sbom_components_retained') IS NOT NULL THEN
      RAISE EXCEPTION 'legacy_sbom_components_retained already exists; refusing to overwrite retained scanner data';
    END IF;
    ALTER TABLE "sbom_components" RENAME TO "legacy_sbom_components_retained";
  END IF;

  IF to_regclass('public.vex_annotations') IS NOT NULL THEN
    IF to_regclass('public.legacy_vex_annotations_retained') IS NOT NULL THEN
      RAISE EXCEPTION 'legacy_vex_annotations_retained already exists; refusing to overwrite retained scanner data';
    END IF;
    ALTER TABLE "vex_annotations" RENAME TO "legacy_vex_annotations_retained";
  END IF;

  IF to_regclass('public.osv_cache') IS NOT NULL THEN
    IF to_regclass('public.legacy_osv_cache_retained') IS NOT NULL THEN
      RAISE EXCEPTION 'legacy_osv_cache_retained already exists; refusing to overwrite retained scanner data';
    END IF;
    ALTER TABLE "osv_cache" RENAME TO "legacy_osv_cache_retained";
  END IF;

  IF to_regclass('public.scanner_db_state') IS NOT NULL THEN
    IF to_regclass('public.legacy_scanner_db_state_retained') IS NOT NULL THEN
      RAISE EXCEPTION 'legacy_scanner_db_state_retained already exists; refusing to overwrite retained scanner data';
    END IF;
    ALTER TABLE "scanner_db_state" RENAME TO "legacy_scanner_db_state_retained";
  END IF;
END $$;
