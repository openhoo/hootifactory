import { bottleFileName, type HomebrewVersionMeta } from "./homebrew-validation";

/** The bottle URL root the JSON API advertises for a repo mount. */
export function bottleRootUrl(base: string): string {
  return `${base}/bottles`;
}

export interface HomebrewBottleFileJson {
  cellar: string;
  url: string;
  sha256: string;
}

/**
 * A single formula object in the Homebrew JSON API shape that `brew`'s
 * `Formulary.from_api` / `Homebrew::API::Formula` install path reads. Real brew
 * raises "key not found" when a custom `HOMEBREW_API_DOMAIN` omits keys it
 * dereferences unconditionally (e.g. `ruby_source_path`), so we emit the full
 * top-level surface with conservative empty/null defaults rather than a minimal
 * subset. Fields hootifactory cannot populate (head builds, caveats, service,
 * etc.) are present-but-empty so reads never miss a key.
 */
export interface HomebrewFormulaJson {
  name: string;
  full_name: string;
  tap: string;
  oldnames: string[];
  aliases: string[];
  versioned_formulae: string[];
  desc: string | null;
  license: string | null;
  homepage: string;
  versions: { stable: string; head: string | null; bottle: boolean };
  urls: {
    stable: { url: string; tag: string | null; revision: string | null; checksum: string | null };
  };
  revision: number;
  version_scheme: number;
  bottle: {
    stable: {
      rebuild: number;
      root_url: string;
      files: Record<string, HomebrewBottleFileJson>;
    };
  };
  pour_bottle_only_if: string | null;
  keg_only: boolean;
  keg_only_reason: string | null;
  options: unknown[];
  build_dependencies: string[];
  dependencies: string[];
  test_dependencies: string[];
  recommended_dependencies: string[];
  optional_dependencies: string[];
  uses_from_macos: unknown[];
  uses_from_macos_bounds: unknown[];
  requirements: unknown[];
  conflicts_with: string[];
  conflicts_with_reasons: string[];
  link_overwrite: string[];
  caveats: string | null;
  installed: unknown[];
  linked_keg: string | null;
  pinned: boolean;
  outdated: boolean;
  deprecated: boolean;
  deprecation_date: string | null;
  deprecation_reason: string | null;
  disabled: boolean;
  disable_date: string | null;
  disable_reason: string | null;
  post_install_defined: boolean;
  service: unknown;
  tap_git_head: string | null;
  ruby_source_path: string;
  ruby_source_checksum: { sha256: string } | Record<string, never>;
  head_dependencies?: unknown;
  variations: Record<string, unknown>;
}

export interface HomebrewFormulaInput {
  name: string;
  version: string;
  metadata: HomebrewVersionMeta;
  /** Absolute repo mount base, e.g. `${ctx.baseUrl}/${ctx.repo.mountPath}`. */
  base: string;
  /** Tap identifier (`owner/name`-shaped), e.g. the repo mount path. */
  tap: string;
}

/** Build a single `formula/:name.json` object from a stable version's metadata. */
export function buildHomebrewFormulaJson(input: HomebrewFormulaInput): HomebrewFormulaJson {
  const { name, version, metadata, base, tap } = input;
  const rootUrl = bottleRootUrl(base);
  const files: Record<string, HomebrewBottleFileJson> = {};
  // Deterministic tag ordering so the JSON document is stable for caching/ETags.
  for (const tag of Object.keys(metadata.bottles).sort()) {
    const bottle = metadata.bottles[tag];
    if (!bottle) continue;
    files[tag] = {
      cellar: "any",
      url: `${rootUrl}/${bottleFileName(name, version, tag)}`,
      sha256: bottle.sha256,
    };
  }
  const dependencies = metadata.dependencies ? [...metadata.dependencies] : [];
  return {
    name,
    full_name: name,
    tap,
    oldnames: [],
    aliases: [],
    versioned_formulae: [],
    desc: metadata.desc ?? null,
    license: metadata.license ?? null,
    homepage: metadata.homepage ?? `${base}/api/formula/${name}.json`,
    versions: { stable: version, head: null, bottle: true },
    // We publish bottles, not source builds; advertise the bottle root as the
    // stable URL so the key is present and dereferenceable.
    urls: { stable: { url: rootUrl, tag: null, revision: null, checksum: null } },
    revision: 0,
    version_scheme: 0,
    bottle: { stable: { rebuild: 0, root_url: rootUrl, files } },
    pour_bottle_only_if: null,
    keg_only: false,
    keg_only_reason: null,
    options: [],
    build_dependencies: [],
    dependencies,
    test_dependencies: [],
    recommended_dependencies: [],
    optional_dependencies: [],
    uses_from_macos: [],
    uses_from_macos_bounds: [],
    requirements: [],
    conflicts_with: [],
    conflicts_with_reasons: [],
    link_overwrite: [],
    caveats: null,
    installed: [],
    linked_keg: null,
    pinned: false,
    outdated: false,
    deprecated: false,
    deprecation_date: null,
    deprecation_reason: null,
    disabled: false,
    disable_date: null,
    disable_reason: null,
    post_install_defined: false,
    service: null,
    tap_git_head: null,
    ruby_source_path: `Formula/${name}.rb`,
    ruby_source_checksum: {},
    variations: {},
  };
}
