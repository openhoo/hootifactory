interface BoundaryRule {
  name: string;
  roots: string[];
  forbidden: RegExp[];
}

const repoRoot = process.cwd().replace(/\/+$/, "");
const registryPluginPackagePattern = /@hootifactory\/registry-(?:cargo|go|npm|nuget|oci|pypi)\b/;

const rules: BoundaryRule[] = [
  {
    name: "core stays infrastructure-free",
    roots: ["packages/core/src", "packages/core/package.json"],
    forbidden: [
      /@hootifactory\/auth\b/,
      /@hootifactory\/db\b/,
      /@hootifactory\/registry-/,
      /@hootifactory\/registry\b/,
      /@hootifactory\/scan-core\b/,
      /@hootifactory\/storage\b/,
      /@hootifactory\/queue\b/,
    ],
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
      registryPluginPackagePattern,
      /@hootifactory\/registry\b/,
      /@hootifactory\/storage\b/,
      /@hootifactory\/queue\b/,
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
      registryPluginPackagePattern,
      /@hootifactory\/registry\b/,
      /@hootifactory\/storage\b/,
      /@hootifactory\/queue\b/,
    ],
  },
  {
    name: "registry plugins do not import delivery frameworks",
    roots: [
      "packages/registry-cargo/src",
      "packages/registry-oci/src",
      "packages/registry-go/src",
      "packages/registry-npm/src",
      "packages/registry-nuget/src",
      "packages/registry-pypi/src",
    ],
    forbidden: [
      /from\s+["']hono/,
      /from\s+["']react/,
      /@hootifactory\/core\b/,
      /@hootifactory\/registry-builtins\b/,
    ],
  },
];

const failures: string[] = [];

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

if (failures.length > 0) {
  console.error("Architecture boundary violations:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Architecture boundaries OK");

async function filesUnder(path: string): Promise<string[]> {
  if (path.endsWith(".json") || path.endsWith(".ts") || path.endsWith(".tsx")) return [path];

  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{json,ts,tsx}");
  for await (const file of glob.scan({ cwd: path, absolute: true, onlyFiles: true })) {
    if (!file.includes("/node_modules/") && !file.includes("/coverage/")) files.push(file);
  }
  return files.sort();
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
