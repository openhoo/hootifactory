interface BoundaryRule {
  name: string;
  roots: string[];
  forbidden: RegExp[];
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

const repoRoot = process.cwd().replace(/\/+$/, "");
const registryPluginPackagePattern = /@hootifactory\/registry-(?:cargo|go|npm|nuget|oci|pypi)\b/;
const workspaceImportPattern =
  /\b(?:from|import)\s*(?:\(\s*)?["'](@hootifactory\/[^"'/]+)(?:\/[^"']*)?["']/g;

const rules: BoundaryRule[] = [
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
    name: "registry application stays delivery-framework-free",
    roots: ["packages/registry-application/src", "packages/registry-application/package.json"],
    forbidden: [/from\s+["']hono/, /from\s+["']react/],
  },
  {
    name: "api composes registry plugins through registry-builtins",
    roots: ["apps/api/src", "apps/api/package.json"],
    forbidden: [registryPluginPackagePattern],
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
      /@hootifactory\/registry-builtins\b/,
      /@hootifactory\/scan-core\b/,
      /@hootifactory\/storage\b/,
    ],
  },
];

const failures: string[] = [];

await checkBoundaryRules();
await checkWorkspaceShape();
await checkWorkspaceManifestDrift();

if (failures.length > 0) {
  console.error("Architecture boundary violations:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Architecture boundaries OK");

async function checkBoundaryRules(): Promise<void> {
  for (const rule of rules) {
    for (const root of rule.roots) {
      for (const file of await filesUnder(pathJoin(repoRoot, root))) {
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
  if (!(await Bun.file(path).exists())) return false;
  for await (const _file of new Bun.Glob("**/*").scan({
    cwd: path,
    absolute: true,
    onlyFiles: true,
  })) {
    return true;
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
