interface BoundaryRule {
  name: string;
  roots: string[];
  forbidden: RegExp[];
  ignoreTests?: boolean;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface WorkspacePackage {
  name: string;
  dir: string;
  manifestPath: string;
  manifest: PackageJson;
}

interface PluginPackage {
  name: string;
  relDir: string;
}

const repoRoot = process.cwd().replace(/\/+$/, "");
const workspaceImportPattern =
  /\b(?:from|import)\s*(?:\(\s*)?["'](@hootifactory\/[^"'/]+)(?:\/[^"']*)?["']/g;

// Plugin package names (and the boundary roots that name them) are derived from
// the workspace at runtime, so adding a registry format or a scanner is purely a
// new package + a manifest line — never a boundary-checker edit.
const NON_PLUGIN_REGISTRY = new Set([
  "registry",
  "registry-application",
  "registry-builtins",
  "registry-runtime",
]);
const NON_PLUGIN_SCANNER = new Set(["scanner", "scanner-runtime"]);

const failures: string[] = [];

const pluginPackages = await discoverPluginPackages();
const registryPluginPackagePattern = packageNamesPattern(pluginPackages.registry);
const scannerPluginPackagePattern = packageNamesPattern(pluginPackages.scanner);
const scannerPluginRoots = pluginPackages.scanner.flatMap((pkg) => [
  `${pkg.relDir}/src`,
  `${pkg.relDir}/package.json`,
]);
const rules = buildRules();

await checkBoundaryRules();
await checkRootPackageImports();
await checkWorkspaceShape();
await checkRegistryApplicationShape();
await checkWorkspaceManifestDrift();

if (failures.length > 0) {
  console.error("Architecture boundary violations:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Architecture boundaries OK");

function buildRules(): BoundaryRule[] {
  return [
    {
      name: "core stays pure and infrastructure-free",
      roots: ["packages/core/src", "packages/core/package.json"],
      forbidden: [
        /\bBun\.env\b/,
        /\bprocess\.env\b/,
        /@hootifactory\/auth\b/,
        /@hootifactory\/config\b/,
        /@hootifactory\/db\b/,
        /@hootifactory\/queue\b/,
        /@hootifactory\/registry\b/,
        /@hootifactory\/registry-/,
        /@hootifactory\/scan-core\b/,
        /@hootifactory\/storage\b/,
      ],
    },
    {
      name: "registry SDK stays infrastructure-free",
      roots: ["packages/registry/src", "packages/registry/package.json"],
      forbidden: [
        /@hootifactory\/auth\b/,
        /@hootifactory\/config\b/,
        /@hootifactory\/db\b/,
        /@hootifactory\/queue\b/,
        /@hootifactory\/registry-application\b/,
        /@hootifactory\/scan-core\b/,
        /@hootifactory\/storage\b/,
      ],
    },
    {
      name: "scanner SDK stays infrastructure-free",
      roots: ["packages/scanner/src", "packages/scanner/package.json"],
      forbidden: [
        /@hootifactory\/auth\b/,
        /@hootifactory\/config\b/,
        /@hootifactory\/db\b/,
        /@hootifactory\/observability\b/,
        /@hootifactory\/queue\b/,
        /@hootifactory\/registry\b/,
        /@hootifactory\/storage\b/,
      ],
    },
    {
      name: "registry application stays delivery-framework-free",
      roots: ["packages/registry-application/src", "packages/registry-application/package.json"],
      forbidden: [/from\s+["']hono/, /from\s+["']react/],
    },
    {
      name: "apps compose registry plugins through registry-runtime",
      roots: [
        "apps/api/src",
        "apps/api/package.json",
        "apps/scan-worker/src",
        "apps/scan-worker/package.json",
      ],
      forbidden: [registryPluginPackagePattern],
    },
    {
      name: "apps compose scanners through scanner-runtime",
      roots: [
        "apps/api/src",
        "apps/api/package.json",
        "apps/scan-worker/src",
        "apps/scan-worker/package.json",
      ],
      forbidden: [scannerPluginPackagePattern],
    },
    {
      name: "web depends on contracts, not backend internals",
      roots: ["apps/web/src", "apps/web/package.json"],
      forbidden: [
        /@hootifactory\/auth\b/,
        /@hootifactory\/core\b/,
        /@hootifactory\/db\b/,
        /@hootifactory\/queue\b/,
        /@hootifactory\/registry\b/,
        registryPluginPackagePattern,
        /@hootifactory\/storage\b/,
      ],
    },
    {
      name: "contracts stay delivery-framework and backend-free",
      roots: ["packages/contracts/src", "packages/contracts/package.json"],
      forbidden: [
        /from\s+["']hono/,
        /from\s+["']react/,
        /@hootifactory\/auth\b/,
        /@hootifactory\/core\b/,
        /@hootifactory\/db\b/,
        /@hootifactory\/queue\b/,
        /@hootifactory\/registry\b/,
        registryPluginPackagePattern,
        /@hootifactory\/storage\b/,
      ],
    },
    {
      name: "non-module runtime uses module descriptors instead of concrete registry/scanner ids",
      roots: [
        "apps/api/src",
        "apps/scan-worker/src",
        "apps/web/src",
        "packages/contracts/src",
        "packages/observability/src",
        "packages/registry-application/src",
      ],
      ignoreTests: true,
      forbidden: [
        /\bPackageFormat\b/,
        /\bpackageFormatEnum\b/,
        /\brepoFormatSpanAttributes\b/,
        /\bformatRegistry\b/,
        /\bregistryErrorResponseForFormat\b/,
        /\bregistryErrorToFormatResponse\b/,
        /\b(?:format|moduleId)\s*[:=]\s*["'](?:npm|pypi|cargo|nuget|oci|helm|maven|generic)["']/,
        /\b(?:scanner|scannerId)\s*[:=]\s*["'](?:grype|trivy|clamav|osv|syft|heuristic)["']/,
        /\b[Oo]ci[A-Z]/,
        /["']\/?v2\//,
      ],
    },
    {
      name: "registry package/version adapters stay DB-free",
      roots: [
        "packages/registry-cargo/src",
        "packages/registry-cargo/package.json",
        "packages/registry-go/src",
        "packages/registry-go/package.json",
        "packages/registry-npm/src",
        "packages/registry-npm/package.json",
        "packages/registry-nuget/src",
        "packages/registry-nuget/package.json",
        "packages/registry-oci/src",
        "packages/registry-oci/package.json",
        "packages/registry-pypi/src",
        "packages/registry-pypi/package.json",
      ],
      forbidden: [/@hootifactory\/db\b/, /\bctx\.db\b/],
    },
    {
      name: "repository configuration route slice stays DB-free",
      roots: [
        "apps/api/src/routes/ui-repository-access.ts",
        "apps/api/src/routes/ui-repository-config.ts",
        "apps/api/src/routes/api-v1-repository-config-routes.ts",
      ],
      forbidden: [/@hootifactory\/db\b/, /\bdb\./],
    },
    {
      name: "content inventory route slice stays DB-free",
      roots: [
        "apps/api/src/routes/ui-content.ts",
        "apps/api/src/routes/ui-artifact-routes.ts",
        "apps/api/src/routes/api-v1-content-routes.ts",
      ],
      forbidden: [/@hootifactory\/db\b/, /\bdb\./],
    },
    {
      name: "governance route slice stays DB-free",
      roots: [
        "apps/api/src/routes/ui-scan-policy-routes.ts",
        "apps/api/src/routes/ui-quota-routes.ts",
        "apps/api/src/routes/api-v1-policy-routes.ts",
      ],
      forbidden: [/@hootifactory\/db\b/, /\bdb\./],
    },
    {
      name: "organization route slice stays DB-free",
      roots: ["apps/api/src/routes/ui.ts", "apps/api/src/routes/api-v1-organization-routes.ts"],
      forbidden: [/@hootifactory\/db\b/, /\bdb\./],
    },
    {
      name: "token route slice stays DB-free",
      roots: [
        "apps/api/src/routes/ui-tokens.ts",
        "apps/api/src/routes/api-v1-token-routes.ts",
        "apps/api/src/routes/api-v1-helpers.ts",
        "apps/api/src/routes/ui-dto.ts",
        "apps/api/src/routes/ui-schemas.ts",
      ],
      forbidden: [/@hootifactory\/db\b/, /\bdb\./],
    },
    {
      name: "auth delivery slice stays DB-free",
      roots: [
        "apps/api/src/routes/auth-local-routes.ts",
        "apps/api/src/routes/auth-password-reset-routes.ts",
        "apps/api/src/routes/auth-oidc-routes.ts",
        "apps/api/src/middleware/authenticate.ts",
      ],
      forbidden: [/@hootifactory\/db\b/, /\bdb\./],
    },
    {
      name: "api app stays DB-free",
      roots: ["apps/api/src", "apps/api/package.json"],
      forbidden: [/@hootifactory\/db\b/, /\bdb\./],
    },
    {
      name: "registry protocol plugins avoid delivery and platform infrastructure",
      roots: [
        "packages/registry-cargo/src",
        "packages/registry-go/src",
        "packages/registry-npm/src",
        "packages/registry-nuget/src",
        "packages/registry-oci/src",
        "packages/registry-pypi/src",
      ],
      forbidden: [
        /from\s+["']hono/,
        /from\s+["']react/,
        /@hootifactory\/auth\b/,
        /@hootifactory\/config\b/,
        /@hootifactory\/core\b/,
        /@hootifactory\/queue\b/,
        /@hootifactory\/registry-runtime\b/,
        /@hootifactory\/scan-core\b/,
        /@hootifactory\/storage\b/,
      ],
    },
    {
      name: "scanner plugins avoid delivery and platform infrastructure",
      roots: scannerPluginRoots,
      forbidden: [
        /from\s+["']hono/,
        /from\s+["']react/,
        /@hootifactory\/auth\b/,
        /@hootifactory\/config\b/,
        /@hootifactory\/core\b/,
        /@hootifactory\/db\b/,
        /@hootifactory\/observability\b/,
        /@hootifactory\/queue\b/,
        /@hootifactory\/registry\b/,
        /@hootifactory\/scanner-runtime\b/,
        /@hootifactory\/storage\b/,
      ],
    },
    {
      // Lock in the registry-type-plugin refactor: the foundational, SDK, auth,
      // persistence, contract, and application packages must never re-acquire
      // OCI/format-specific identity (types, media types, the data namespace, or
      // the format-named tables). Only registry-<type> plugins + the runtime
      // manifest may name a format.
      name: "agnostic packages stay free of OCI/format-specific identity",
      roots: [
        "packages/types/src",
        "packages/core/src",
        "packages/registry/src",
        "packages/auth/src",
        "packages/db/src",
        "packages/contracts/src",
        "packages/registry-application/src",
      ],
      ignoreTests: true,
      forbidden: [
        // Case-insensitive so a lowercase identifier (e.g. ociManifestFoo) cannot
        // slip past, while still allowing words that merely contain "oci"
        // (associate, velocity) via the leading word boundary.
        /\b[Oo]ci[A-Z]/,
        /\bOCI_MEDIA_TYPES\b/,
        /\bdata\.oci\b/,
        /\boci_manifests\b/,
        /\boci_tags\b/,
        /\boci_manifest_blob_refs\b/,
        /\bociManifestId\b/,
        // The OCI distribution mount prefix is module grammar; it must not appear
        // in any agnostic package (route matching, scope matching, etc.).
        /["']\/?v2\//,
      ],
    },
    {
      // Agnostic auth must never re-acquire a module's action grammar (e.g. the
      // Docker pull/push verbs). Auth reasons over generic read/write/delete.
      name: "agnostic auth stays free of module-specific action grammar",
      roots: ["packages/auth/src"],
      ignoreTests: true,
      forbidden: [/["'](?:pull|push)["']/],
    },
  ];
}

async function discoverPluginPackages(): Promise<{
  registry: PluginPackage[];
  scanner: PluginPackage[];
}> {
  const registry: PluginPackage[] = [];
  const scanner: PluginPackage[] = [];
  for (const pkg of await workspacePackages()) {
    const short = pkg.name.replace(/^@hootifactory\//, "");
    const entry: PluginPackage = { name: pkg.name, relDir: relativePath(repoRoot, pkg.dir) };
    if (short.startsWith("registry-") && !NON_PLUGIN_REGISTRY.has(short)) registry.push(entry);
    if (short.startsWith("scanner-") && !NON_PLUGIN_SCANNER.has(short)) scanner.push(entry);
  }
  return { registry, scanner };
}

/** A regex matching any of the given workspace package names as an import specifier. */
function packageNamesPattern(packages: PluginPackage[]): RegExp {
  if (packages.length === 0) return /(?!x)x/;
  const alternation = packages
    .map((pkg) => escapeRegExp(pkg.name.replace(/^@hootifactory\//, "")))
    .join("|");
  return new RegExp(`@hootifactory\\/(?:${alternation})\\b`);
}

async function checkBoundaryRules(): Promise<void> {
  for (const rule of rules) {
    for (const root of rule.roots) {
      for (const file of await filesUnder(pathJoin(repoRoot, root))) {
        if (rule.ignoreTests && isTestFile(file)) continue;
        const content = await Bun.file(file).text();
        for (const pattern of rule.forbidden) {
          if (pattern.test(content)) {
            failures.push(`${rule.name}: ${relativePath(repoRoot, file)} matches ${pattern}`);
          }
        }
      }
    }
  }
}

function isTestFile(path: string): boolean {
  return /\.test\.[cm]?[tj]sx?$/.test(path);
}

async function checkRootPackageImports(): Promise<void> {
  for (const file of await sourceFilesUnder(["apps", "packages"])) {
    const content = await Bun.file(file).text();
    const relative = relativePath(repoRoot, file);
    if (hasExactWorkspaceImport(content, "@hootifactory/registry-application")) {
      failures.push(
        `${relative} imports @hootifactory/registry-application root; use a feature-slice subpath`,
      );
    }
    if (
      hasExactWorkspaceImport(content, "@hootifactory/contracts") &&
      !isApiV1RouteSource(relative)
    ) {
      failures.push(
        `${relative} imports @hootifactory/contracts root outside API v1 routes; use @hootifactory/contracts/legacy for UI DTO/client code`,
      );
    }
  }
}

async function sourceFilesUnder(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    for await (const file of new Bun.Glob("*/src/**/*.{ts,tsx}").scan({
      cwd: pathJoin(repoRoot, root),
      absolute: true,
      onlyFiles: true,
    })) {
      if (!file.includes("/coverage/")) files.push(file);
    }
  }
  return files.sort();
}

function hasExactWorkspaceImport(content: string, packageName: string): boolean {
  const pattern = new RegExp(
    String.raw`\b(?:from|import)\s*(?:\(\s*)?["']${escapeRegExp(packageName)}["']`,
  );
  return pattern.test(content);
}

function isApiV1RouteSource(relative: string): boolean {
  return /^apps\/api\/src\/routes\/api-v1(?:-|\.ts)/.test(relative);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function checkWorkspaceShape(): Promise<void> {
  for (const base of ["apps", "packages"]) {
    const cwd = pathJoin(repoRoot, base);
    for await (const entry of new Bun.Glob("*").scan({
      cwd,
      absolute: false,
      onlyFiles: false,
    })) {
      if (entry.includes("/")) continue;
      const dir = pathJoin(cwd, entry);
      const manifestPath = pathJoin(dir, "package.json");
      if (await Bun.file(manifestPath).exists()) continue;
      if (await hasFilesUnder(pathJoin(dir, "src"))) {
        failures.push(`${base}/${entry} has source files but no package.json`);
      }
    }
  }
}

async function checkRegistryApplicationShape(): Promise<void> {
  const src = pathJoin(repoRoot, "packages/registry-application/src");
  const allowedRootFiles = new Set(["index.ts"]);
  const expectedSlices = [
    "content",
    "governance",
    "inventory",
    "packages",
    "repositories",
    "routing",
    "runtime",
  ];

  for await (const file of new Bun.Glob("*.ts").scan({
    cwd: src,
    absolute: false,
    onlyFiles: true,
  })) {
    if (!allowedRootFiles.has(file)) {
      failures.push(`registry-application root file ${file} should live in a feature slice`);
    }
  }

  for (const slice of expectedSlices) {
    if (!(await hasFilesUnder(pathJoin(src, slice)))) {
      failures.push(`registry-application is missing feature slice ${slice}`);
      continue;
    }
    if (!(await Bun.file(pathJoin(src, slice, "index.ts")).exists())) {
      failures.push(`registry-application feature slice ${slice} is missing index.ts`);
    }
  }
}

async function checkWorkspaceManifestDrift(): Promise<void> {
  const packages = await workspacePackages();
  const workspaceNames = new Set(packages.map((pkg) => pkg.name));

  for (const pkg of packages) {
    const importsByPackage = new Map<string, Set<string>>();
    for (const file of await filesUnder(pathJoin(pkg.dir, "src"), "**/*.{ts,tsx}")) {
      const content = await Bun.file(file).text();
      for (const imported of workspaceImports(content)) {
        if (!workspaceNames.has(imported) || imported === pkg.name) continue;
        const files = importsByPackage.get(imported) ?? new Set<string>();
        files.add(relativePath(repoRoot, file));
        importsByPackage.set(imported, files);
      }
    }

    const declared = declaredWorkspaceDeps(pkg.manifest, workspaceNames);
    for (const imported of importsByPackage.keys()) {
      if (declared.has(imported)) continue;
      const files = [...(importsByPackage.get(imported) ?? [])].slice(0, 3).join(", ");
      failures.push(
        `${pkg.name} imports ${imported} but does not declare it in package.json (${files})`,
      );
    }

    for (const dep of declared) {
      if (importsByPackage.has(dep)) continue;
      failures.push(`${pkg.name} declares unused workspace dependency ${dep}`);
    }
  }
}

async function workspacePackages(): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const base of ["apps", "packages"]) {
    const cwd = pathJoin(repoRoot, base);
    for await (const manifest of new Bun.Glob("*/package.json").scan({
      cwd,
      absolute: true,
      onlyFiles: true,
    })) {
      const parsed = (await Bun.file(manifest).json()) as PackageJson;
      if (!parsed.name) {
        failures.push(`${relativePath(repoRoot, manifest)} is missing a package name`);
        continue;
      }
      packages.push({
        name: parsed.name,
        dir: manifest.slice(0, -"/package.json".length),
        manifestPath: manifest,
        manifest: parsed,
      });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function declaredWorkspaceDeps(manifest: PackageJson, workspaceNames: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const deps of [
    manifest.dependencies ?? {},
    manifest.devDependencies ?? {},
    manifest.peerDependencies ?? {},
  ]) {
    for (const [name, version] of Object.entries(deps)) {
      if (version === "workspace:*" && workspaceNames.has(name)) out.add(name);
    }
  }
  return out;
}

function workspaceImports(content: string): string[] {
  const imports: string[] = [];
  workspaceImportPattern.lastIndex = 0;
  for (const match of content.matchAll(workspaceImportPattern)) {
    if (match[1]) imports.push(match[1]);
  }
  return imports;
}

async function filesUnder(path: string, pattern = "**/*.{json,ts,tsx}"): Promise<string[]> {
  if (!(await Bun.file(path).exists()) && !path.endsWith("/src")) return [];
  if (path.endsWith(".json") || path.endsWith(".ts") || path.endsWith(".tsx")) return [path];

  const files: string[] = [];
  const glob = new Bun.Glob(pattern);
  for await (const file of glob.scan({ cwd: path, absolute: true, onlyFiles: true })) {
    if (!file.includes("/node_modules/") && !file.includes("/coverage/")) files.push(file);
  }
  return files.sort();
}

async function hasFilesUnder(path: string): Promise<boolean> {
  try {
    for await (const _file of new Bun.Glob("**/*").scan({
      cwd: path,
      absolute: true,
      onlyFiles: true,
    })) {
      return true;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return false;
}

function pathJoin(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "")))
    .join("/");
}

function relativePath(base: string, path: string): string {
  const normalizedBase = `${base.replace(/\/+$/, "")}/`;
  return path.startsWith(normalizedBase) ? path.slice(normalizedBase.length) : path;
}
