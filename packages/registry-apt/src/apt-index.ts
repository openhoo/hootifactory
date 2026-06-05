/**
 * APT index generation. Generates a suite's `Packages`/`Packages.gz` (per
 * component+arch) and the `Release` together from one snapshot, so the Release
 * checksums always match the exact Packages bytes served (a mismatch aborts
 * `apt-get update`). `arch=all` packages are folded into every architecture.
 */

export interface AptDebEntry {
  controlText: string;
  /** Repository-relative pool path, used as the Packages `Filename`. */
  filename: string;
  size: number;
  md5: string;
  sha256: string;
  package: string;
  version: string;
  architecture: string;
  component: string;
}

export interface AptSnapshot {
  release: string;
  /** key = `<component>/binary-<arch>` */
  packages: Map<string, { text: string; gz: Uint8Array }>;
}

function md5Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("md5").update(bytes).digest("hex");
}
function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Concatenated, deterministically-ordered Packages stanzas for one component+arch. */
export function buildPackagesText(entries: AptDebEntry[]): string {
  const sorted = [...entries].sort(
    (a, b) =>
      compare(a.package, b.package) ||
      compare(a.version, b.version) ||
      compare(a.architecture, b.architecture),
  );
  return sorted
    .map(
      (entry) =>
        `${entry.controlText}\nFilename: ${entry.filename}\nSize: ${entry.size}\n` +
        `MD5sum: ${entry.md5}\nSHA256: ${entry.sha256}\n`,
    )
    .join("\n");
}

interface ReleaseFile {
  path: string;
  size: number;
  md5: string;
  sha256: string;
}

function buildRelease(input: {
  suite: string;
  components: string[];
  architectures: string[];
  date: string;
  files: ReleaseFile[];
}): string {
  const lines = [
    "Origin: Hootifactory",
    "Label: Hootifactory",
    `Suite: ${input.suite}`,
    `Codename: ${input.suite}`,
    `Date: ${input.date}`,
    `Architectures: ${input.architectures.join(" ")}`,
    `Components: ${input.components.join(" ")}`,
    "Description: Hootifactory APT repository",
    "MD5Sum:",
    ...input.files.map((file) => ` ${file.md5} ${file.size} ${file.path}`),
    "SHA256:",
    ...input.files.map((file) => ` ${file.sha256} ${file.size} ${file.path}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function buildAptSnapshot(suite: string, date: string, entries: AptDebEntry[]): AptSnapshot {
  const components = [...new Set(entries.map((entry) => entry.component))].sort(compare);
  const architectures = [
    ...new Set(entries.filter((entry) => entry.architecture !== "all").map((e) => e.architecture)),
  ].sort(compare);
  const packages = new Map<string, { text: string; gz: Uint8Array }>();
  const files: ReleaseFile[] = [];
  for (const component of components) {
    for (const arch of architectures) {
      const subset = entries.filter(
        (entry) =>
          entry.component === component &&
          (entry.architecture === arch || entry.architecture === "all"),
      );
      const text = buildPackagesText(subset);
      const textBytes = new TextEncoder().encode(text);
      const gz = Bun.gzipSync(textBytes);
      const key = `${component}/binary-${arch}`;
      packages.set(key, { text, gz });
      files.push({
        path: `${key}/Packages`,
        size: textBytes.byteLength,
        md5: md5Hex(textBytes),
        sha256: sha256Hex(textBytes),
      });
      files.push({
        path: `${key}/Packages.gz`,
        size: gz.byteLength,
        md5: md5Hex(gz),
        sha256: sha256Hex(gz),
      });
    }
  }
  return { release: buildRelease({ suite, components, architectures, date, files }), packages };
}
