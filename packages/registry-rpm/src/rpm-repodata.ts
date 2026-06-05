import { computeDigest, digestHex } from "@hootifactory/registry";
import { type RpmVersionMeta, rpmVersionKey } from "./rpm-validation";

/**
 * One package as it appears in `primary.xml`. `href` is the download path of the
 * `.rpm` relative to the repo mount (`packages/<file>`).
 */
export interface RpmPrimaryPackage {
  meta: RpmVersionMeta;
  href: string;
  /** createdAt epoch (seconds) of the version, used for <time>/repo timestamp. */
  buildTime: number;
}

export interface BuiltPrimary {
  /** gzip(primary.xml) — the exact bytes served at repodata/primary.xml.gz. */
  gz: Uint8Array;
  /** the uncompressed primary.xml bytes. */
  plain: Uint8Array;
  sha256Gz: string;
  sha256Plain: string;
  sizeGz: number;
  sizePlain: number;
  /** repo revision/timestamp (seconds), derived from package build times. */
  timestamp: number;
  packageCount: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Total order over packages so two builds of the same input render identical
 * bytes: by name, then arch, then `epoch:ver-rel`, then href as a final tiebreak.
 */
export function compareRpmPrimaryPackages(a: RpmPrimaryPackage, b: RpmPrimaryPackage): number {
  if (a.meta.name !== b.meta.name) return a.meta.name < b.meta.name ? -1 : 1;
  if (a.meta.arch !== b.meta.arch) return a.meta.arch < b.meta.arch ? -1 : 1;
  const ka = rpmVersionKey(a.meta);
  const kb = rpmVersionKey(b.meta);
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.href !== b.href) return a.href < b.href ? -1 : 1;
  return 0;
}

function renderPackageXml(pkg: RpmPrimaryPackage): string {
  const { meta } = pkg;
  return (
    `<package type="rpm">` +
    `<name>${escapeXml(meta.name)}</name>` +
    `<arch>${escapeXml(meta.arch)}</arch>` +
    `<version epoch="${meta.epoch}" ver="${escapeXml(meta.ver)}" rel="${escapeXml(meta.rel)}"/>` +
    `<checksum type="sha256" pkgid="YES">${meta.sha256}</checksum>` +
    `<summary>${escapeXml(meta.summary ?? "")}</summary>` +
    `<description>${escapeXml(meta.summary ?? "")}</description>` +
    `<packager></packager>` +
    `<url></url>` +
    `<time file="${pkg.buildTime}" build="${pkg.buildTime}"/>` +
    // `package` is the exact on-disk `.rpm` size. `installed`/`archive` (the
    // uncompressed installed/cpio-payload sizes) are not derived from the binary
    // here, so they reuse `package` as a placeholder. DNF does not validate these.
    `<size package="${meta.size}" installed="${meta.size}" archive="${meta.size}"/>` +
    `<location href="${escapeXml(pkg.href)}"/>` +
    `<format>` +
    `<rpm:license></rpm:license>` +
    `<rpm:vendor></rpm:vendor>` +
    `<rpm:group></rpm:group>` +
    `<rpm:buildhost></rpm:buildhost>` +
    `<rpm:sourcerpm></rpm:sourcerpm>` +
    `</format>` +
    `</package>`
  );
}

/**
 * Render + gzip the primary metadata from the given (already-built) packages.
 * Deterministic: packages are sorted with a total order and gzip is byte-stable
 * for identical input. The same builder feeds BOTH the repomd handler and the
 * primary.xml.gz handler so the checksum in repomd always matches the bytes.
 */
export function buildPrimary(packages: RpmPrimaryPackage[]): BuiltPrimary {
  const sorted = [...packages].sort(compareRpmPrimaryPackages);
  const body = sorted.map(renderPackageXml).join("");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<metadata xmlns="http://linux.duke.edu/metadata/common" ` +
    `xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="${sorted.length}">` +
    body +
    `</metadata>\n`;

  const plain = new TextEncoder().encode(xml);
  const gz = Bun.gzipSync(plain);
  const sha256Plain = digestHex(computeDigest(plain));
  const sha256Gz = digestHex(computeDigest(gz));

  // The repo revision is derived from the data (max build time), never the wall
  // clock, so repomd is reproducible. Empty repo => epoch 0.
  const timestamp = sorted.reduce((max, p) => Math.max(max, p.buildTime), 0);

  return {
    gz,
    plain,
    sha256Gz,
    sha256Plain,
    sizeGz: gz.length,
    sizePlain: plain.length,
    timestamp,
    packageCount: sorted.length,
  };
}

/**
 * Render `repomd.xml` referencing the primary metadata. The `<checksum>` is the
 * sha256 of the exact `primary.xml.gz` bytes, so a client that fetches that file
 * and hashes it gets the value embedded here.
 *
 * SIMPLIFICATION: only `<data type="primary">` is advertised — no
 * `filelists.xml.gz`/`other.xml.gz`. Modern DNF (DNF5, and DNF4 with
 * conditional-filelists, the default since Fedora 35) treats `primary` as
 * always-required and `filelists` as optional, so install/update works. Clients
 * that need file-path-based dependency resolution (`Requires: /some/path`) or
 * older yum/reposync/mirroring tools that expect `filelists` will not find it.
 */
export function buildRepomd(primary: BuiltPrimary): string {
  const rev = primary.timestamp;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<repomd xmlns="http://linux.duke.edu/metadata/repo" ` +
    `xmlns:rpm="http://linux.duke.edu/metadata/rpm">` +
    `<revision>${rev}</revision>` +
    `<data type="primary">` +
    `<checksum type="sha256">${primary.sha256Gz}</checksum>` +
    `<open-checksum type="sha256">${primary.sha256Plain}</open-checksum>` +
    `<location href="repodata/primary.xml.gz"/>` +
    `<timestamp>${rev}</timestamp>` +
    `<size>${primary.sizeGz}</size>` +
    `<open-size>${primary.sizePlain}</open-size>` +
    `</data>` +
    `</repomd>\n`
  );
}
