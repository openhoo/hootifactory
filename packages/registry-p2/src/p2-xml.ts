/**
 * Small, dependency-free serializers for the two Eclipse P2 repository documents:
 *
 *  - `content.xml`   — the metadata repository: a `<repository>` listing
 *                      installable units (one per published bundle/feature) with
 *                      an id + version and the OSGi capabilities/requirements a p2
 *                      director needs to resolve them.
 *  - `artifacts.xml` — the artifact repository: the mapping rules that turn a
 *                      `(classifier, id, version)` tuple into a download URL, plus
 *                      one `<artifact>` element per stored jar.
 *
 * Both are regenerated from live versions on every read, so the documents always
 * reflect the current repository contents.
 */

import { classifierForKind, hexDigest, iuIdForUnit, type P2VersionMeta } from "./p2-validation";

/** XML-escape a text/attribute value (the five predefined entities). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Deterministic ordering so regenerated documents (and their ETags) are stable. */
function sortUnits(units: P2VersionMeta[]): P2VersionMeta[] {
  return [...units].sort(
    (a, b) =>
      compare(a.symbolicName, b.symbolicName) ||
      compare(a.version, b.version) ||
      compare(a.kind, b.kind),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A single installable unit (`<unit>`) with the capabilities it provides. */
function renderUnit(unit: P2VersionMeta): string {
  // The IU id is the bare symbolic name for bundles, `<name>.feature.group` for
  // features, so `-installIU <id>` resolves the unit by id (the artifact id stays
  // the bare symbolic name to match the stored jar filename).
  const iuId = escapeXml(iuIdForUnit(unit));
  const artifactId = escapeXml(unit.symbolicName);
  const version = escapeXml(unit.version);
  // Every IU MUST advertise its own id in the p2 IU namespace so a director can
  // resolve it; bundles additionally advertise the OSGi bundle capability.
  const provides =
    unit.kind === "feature"
      ? [
          `        <provided namespace="org.eclipse.equinox.p2.iu" name="${iuId}" version="${version}"/>`,
        ]
      : [
          `        <provided namespace="org.eclipse.equinox.p2.iu" name="${iuId}" version="${version}"/>`,
          `        <provided namespace="osgi.bundle" name="${artifactId}" version="${version}"/>`,
        ];
  return [
    `    <unit id="${iuId}" version="${version}">`,
    `      <provides size='${provides.length}'>`,
    ...provides,
    "      </provides>",
    `      <artifacts size='1'>`,
    `        <artifact classifier="${escapeXml(classifierForKind(unit.kind))}" id="${artifactId}" version="${version}"/>`,
    "      </artifacts>",
    ...renderTouchpoint(unit),
    "    </unit>",
  ].join("\n");
}

/**
 * The p2 engine install action. Bundle units carry the OSGi touchpoint plus a
 * `manifest` instruction (the director writes the bundle into `plugins/` and
 * configures it from this); feature-group units carry the null touchpoint.
 */
function renderTouchpoint(unit: P2VersionMeta): string[] {
  if (unit.kind === "feature") {
    return ["      <touchpoint id='null' version='0.0.0'/>"];
  }
  const manifest = escapeXml(
    `Bundle-SymbolicName: ${unit.symbolicName}\nBundle-Version: ${unit.version}\n`,
  );
  return [
    "      <touchpoint id='org.eclipse.equinox.p2.osgi' version='1.0.0'/>",
    "      <touchpointData size='1'>",
    "        <instructions size='1'>",
    `          <instruction key='manifest'>${manifest}</instruction>`,
    "        </instructions>",
    "      </touchpointData>",
  ];
}

/**
 * A content-derived, deterministic `p2.timestamp` (epoch millis). Stable across
 * identical reads (so the regenerated document and its ETag stay byte-stable) and
 * changes whenever the unit set changes, which is exactly what a director's
 * repository cache uses to decide whether to refresh.
 */
function repositoryTimestamp(units: P2VersionMeta[]): string {
  const fingerprint = units
    .map((u) => `${u.kind}:${u.symbolicName}:${u.version}:${u.blobDigest}`)
    .join("\n");
  const hex = new Bun.CryptoHasher("sha1").update(fingerprint).digest("hex").slice(0, 12);
  // A stable 13-digit epoch-millis value derived from the content fingerprint.
  return ((Number.parseInt(hex, 16) % 9_000_000_000_000) + 1_000_000_000_000).toString();
}

/** Repository-level `<properties>` shared by content.xml and artifacts.xml. */
function repositoryProperties(timestamp: string): string[] {
  return [
    "  <properties size='2'>",
    `    <property name='p2.timestamp' value='${timestamp}'/>`,
    "    <property name='p2.compressed' value='false'/>",
    "  </properties>",
  ];
}

/** Serialize the metadata repository (`content.xml`) from live installable units. */
export function buildContentXml(repositoryName: string, units: P2VersionMeta[]): string {
  const sorted = sortUnits(units);
  const body = sorted.map(renderUnit).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<?metadataRepository version='1.1.0'?>",
    `<repository name="${escapeXml(repositoryName)}" type="org.eclipse.equinox.p2.metadata.repository.simpleRepository" version="1">`,
    ...repositoryProperties(repositoryTimestamp(sorted)),
    `  <units size='${sorted.length}'>`,
    ...(body ? [body] : []),
    "  </units>",
    "</repository>",
    "",
  ].join("\n");
}

/** A single `<artifact>` element keyed by `(classifier, id, version)`. */
function renderArtifact(unit: P2VersionMeta): string {
  const id = escapeXml(unit.symbolicName);
  const version = escapeXml(unit.version);
  const classifier = escapeXml(classifierForKind(unit.kind));
  // Jars are STORED, so artifact.size == download.size. The sha-256 checksum lets
  // the director integrity-verify the download (derived from the stored digest).
  const properties = [
    `        <property name='artifact.size' value='${unit.sizeBytes}'/>`,
    `        <property name='download.size' value='${unit.sizeBytes}'/>`,
    `        <property name='download.checksum.sha-256' value='${escapeXml(hexDigest(unit.blobDigest))}'/>`,
  ];
  return [
    `    <artifact classifier="${classifier}" id="${id}" version="${version}">`,
    `      <properties size='${properties.length}'>`,
    ...properties,
    "      </properties>",
    "    </artifact>",
  ].join("\n");
}

// P2 mapping-rule output templates are literal strings interpreted by the p2
// director (it substitutes `${repoUrl}`/`${id}`/`${version}`); they are built
// here from the bare `${...}` token so it is never a real JS template literal.
const VAR = "$";
const RULE_BUNDLE = `    <rule filter='(&amp; (classifier=osgi.bundle))' output='${VAR}{repoUrl}/plugins/${VAR}{id}_${VAR}{version}.jar'/>`;
const RULE_FEATURE = `    <rule filter='(&amp; (classifier=org.eclipse.update.feature))' output='${VAR}{repoUrl}/features/${VAR}{id}_${VAR}{version}.jar'/>`;

/** Serialize the artifact repository (`artifacts.xml`) from live installable units. */
export function buildArtifactsXml(repositoryName: string, units: P2VersionMeta[]): string {
  const sorted = sortUnits(units);
  const body = sorted.map(renderArtifact).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<?artifactRepository version='1.1.0'?>",
    `<repository name="${escapeXml(repositoryName)}" type="org.eclipse.equinox.p2.artifact.repository.simpleRepository" version="1">`,
    ...repositoryProperties(repositoryTimestamp(sorted)),
    "  <mappings size='2'>",
    RULE_BUNDLE,
    RULE_FEATURE,
    "  </mappings>",
    `  <artifacts size='${sorted.length}'>`,
    ...(body ? [body] : []),
    "  </artifacts>",
    "</repository>",
    "",
  ].join("\n");
}

/**
 * Wrap an XML document into a single-entry, STORED (uncompressed) jar/zip whose
 * entry name is `entryName` (e.g. `content.xml`). P2 serves `content.jar` /
 * `artifacts.jar` as jar-zipped copies of the corresponding `.xml`. We use the
 * STORED method so the serializer stays dependency-free and deterministic.
 */
export function zipSingleEntry(entryName: string, data: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(entryName);
  const crc = crc32(data);
  const size = data.byteLength;

  const local = new Uint8Array(30 + nameBytes.byteLength);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); // local file header signature
  lv.setUint16(4, 20, true); // version needed
  lv.setUint16(6, 0, true); // flags
  lv.setUint16(8, 0, true); // method = STORED
  lv.setUint16(10, 0, true); // mod time
  lv.setUint16(12, 0x21, true); // mod date (1980-01-01)
  lv.setUint32(14, crc, true);
  lv.setUint32(18, size, true); // compressed size
  lv.setUint32(22, size, true); // uncompressed size
  lv.setUint16(26, nameBytes.byteLength, true);
  lv.setUint16(28, 0, true); // extra length
  local.set(nameBytes, 30);

  const central = new Uint8Array(46 + nameBytes.byteLength);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); // central directory header signature
  cv.setUint16(4, 20, true); // version made by
  cv.setUint16(6, 20, true); // version needed
  cv.setUint16(8, 0, true); // flags
  cv.setUint16(10, 0, true); // method = STORED
  cv.setUint16(12, 0, true); // mod time
  cv.setUint16(14, 0x21, true); // mod date
  cv.setUint32(16, crc, true);
  cv.setUint32(20, size, true); // compressed size
  cv.setUint32(24, size, true); // uncompressed size
  cv.setUint16(28, nameBytes.byteLength, true);
  cv.setUint16(30, 0, true); // extra length
  cv.setUint16(32, 0, true); // comment length
  cv.setUint16(34, 0, true); // disk number
  cv.setUint16(36, 0, true); // internal attrs
  cv.setUint32(38, 0, true); // external attrs
  cv.setUint32(42, 0, true); // local header offset
  central.set(nameBytes, 46);

  const localEnd = local.byteLength + size;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true); // disk
  ev.setUint16(6, 0, true); // central dir start disk
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // total entries
  ev.setUint32(12, central.byteLength, true); // central dir size
  ev.setUint32(16, localEnd, true); // central dir offset
  ev.setUint16(20, 0, true); // comment length

  const out = new Uint8Array(localEnd + central.byteLength + eocd.byteLength);
  out.set(local, 0);
  out.set(data, local.byteLength);
  out.set(central, localEnd);
  out.set(eocd, localEnd + central.byteLength);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
