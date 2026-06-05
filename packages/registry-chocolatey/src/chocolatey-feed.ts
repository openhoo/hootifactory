import {
  type ChocolateyVersionMeta,
  escapeXml,
  isPrereleaseChocolateyVersion,
} from "./chocolatey-validation";

/**
 * Atom/OData v2 feed rendering for the Chocolatey (NuGet v2) protocol. Each
 * package version is a V2FeedPackage entry whose typed values live under
 * `<m:properties>`; the .nupkg download url is the entry `<content>` src.
 */

const ATOM_NS = "http://www.w3.org/2005/Atom";
const DS_NS = "http://schemas.microsoft.com/ado/2007/08/dataservices";
const M_NS = "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata";
const APP_NS = "http://www.w3.org/2007/app";
const SCHEME = "http://schemas.microsoft.com/ado/2007/08/dataservices/scheme";

export const ATOM_FEED_CONTENT_TYPE = "application/atom+xml;type=feed;charset=utf-8";
export const ATOM_ENTRY_CONTENT_TYPE = "application/atom+xml;type=entry;charset=utf-8";
export const XML_CONTENT_TYPE = "application/xml; charset=utf-8";

export interface ChocolateyEntryInput {
  metadata: ChocolateyVersionMeta;
  /** Whether this is the latest stable version of its package. */
  isLatestVersion: boolean;
  /** Whether this is the latest version of its package, including prereleases. */
  isAbsoluteLatestVersion: boolean;
  published: string;
}

/** AtomPub service document advertising the `Packages` collection. */
export function buildServiceDocument(base: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n` +
    `<service xml:base="${escapeXml(`${base}/`)}" xmlns="${APP_NS}" xmlns:atom="${ATOM_NS}">` +
    `<workspace><atom:title>Default</atom:title>` +
    `<collection href="Packages"><atom:title>Packages</atom:title></collection>` +
    `</workspace></service>\n`
  );
}

/** A fixed EDMX document describing the V2FeedPackage entity type. */
export function buildMetadataDocument(): string {
  return (
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n` +
    `<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">` +
    `<edmx:DataServices xmlns:m="${M_NS}" m:DataServiceVersion="2.0">` +
    `<Schema Namespace="NuGet.Server.DataServices" xmlns="http://schemas.microsoft.com/ado/2006/04/edm">` +
    `<EntityType Name="V2FeedPackage" m:HasStream="true">` +
    `<Key><PropertyRef Name="Id"/><PropertyRef Name="Version"/></Key>` +
    `<Property Name="Id" Type="Edm.String" Nullable="false"/>` +
    `<Property Name="Version" Type="Edm.String" Nullable="false"/>` +
    `<Property Name="Title" Type="Edm.String"/>` +
    `<Property Name="Authors" Type="Edm.String"/>` +
    `<Property Name="Description" Type="Edm.String"/>` +
    `<Property Name="Tags" Type="Edm.String"/>` +
    `<Property Name="IsLatestVersion" Type="Edm.Boolean" Nullable="false"/>` +
    `<Property Name="IsAbsoluteLatestVersion" Type="Edm.Boolean" Nullable="false"/>` +
    `<Property Name="IsPrerelease" Type="Edm.Boolean" Nullable="false"/>` +
    `<Property Name="PackageHash" Type="Edm.String"/>` +
    `<Property Name="PackageHashAlgorithm" Type="Edm.String"/>` +
    `<Property Name="PackageSize" Type="Edm.Int64" Nullable="false"/>` +
    `<Property Name="Published" Type="Edm.DateTime" Nullable="false"/>` +
    `<Property Name="Dependencies" Type="Edm.String"/>` +
    `</EntityType>` +
    `<EntityContainer Name="FeedContext" m:IsDefaultEntityContainer="true">` +
    `<EntitySet Name="Packages" EntityType="NuGet.Server.DataServices.V2FeedPackage"/>` +
    `</EntityContainer>` +
    `</Schema></edmx:DataServices></edmx:Edmx>\n`
  );
}

/** OData encodes a dependency set as "id:range:tfm|id:range:tfm". */
export function encodeDependencies(metadata: ChocolateyVersionMeta): string {
  return (metadata.dependencies ?? []).map((dep) => `${dep.id}:${dep.range}:`).join("|");
}

function property(name: string, value: string, type?: string, nullableEmpty = false): string {
  if (value === "" && nullableEmpty) {
    return `<d:${name} m:null="true"/>`;
  }
  const typeAttr = type ? ` m:type="${type}"` : "";
  return `<d:${name}${typeAttr}>${escapeXml(value)}</d:${name}>`;
}

/** Render a single V2FeedPackage `<entry>` (without the feed wrapper). */
export function buildEntry(base: string, input: ChocolateyEntryInput): string {
  const { metadata } = input;
  const downloadUrl = `${base}/api/v2/package/${encodeURIComponent(metadata.id.toLowerCase())}/${encodeURIComponent(metadata.version)}`;
  const entryId = `${base}/api/v2/Packages(Id='${escapeXml(metadata.id)}',Version='${escapeXml(metadata.version)}')`;
  return (
    `<entry>` +
    `<id>${escapeXml(entryId)}</id>` +
    `<title type="text">${escapeXml(metadata.id)}</title>` +
    `<content type="application/zip" src="${escapeXml(downloadUrl)}"/>` +
    `<category term="NuGet.Server.DataServices.V2FeedPackage" scheme="${SCHEME}"/>` +
    `<m:properties>` +
    property("Id", metadata.id) +
    property("Version", metadata.version) +
    property("Title", metadata.title ?? metadata.id) +
    // Authors/Description/Tags are optional in the nuspec; NuGet emits
    // m:null="true" for an absent value rather than an empty element.
    property("Authors", metadata.authors ?? "", undefined, true) +
    property("Description", metadata.description ?? "", undefined, true) +
    property("Tags", metadata.tags ?? "", undefined, true) +
    property("IsLatestVersion", String(input.isLatestVersion), "Edm.Boolean") +
    property("IsAbsoluteLatestVersion", String(input.isAbsoluteLatestVersion), "Edm.Boolean") +
    property(
      "IsPrerelease",
      String(isPrereleaseChocolateyVersion(metadata.version)),
      "Edm.Boolean",
    ) +
    property("PackageHash", metadata.packageHash) +
    property("PackageHashAlgorithm", metadata.packageHashAlgorithm) +
    property("PackageSize", String(metadata.size), "Edm.Int64") +
    property("Published", input.published, "Edm.DateTime") +
    property("Dependencies", encodeDependencies(metadata)) +
    `</m:properties>` +
    `</entry>`
  );
}

/** Wrap zero or more rendered entries into an Atom `<feed>`. */
export function buildFeed(base: string, entries: string[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n` +
    `<feed xml:base="${escapeXml(`${base}/api/v2/`)}" xmlns="${ATOM_NS}" xmlns:d="${DS_NS}" xmlns:m="${M_NS}">` +
    `<title type="text">Packages</title>` +
    `<id>${escapeXml(`${base}/api/v2/Packages`)}</id>` +
    entries.join("") +
    `</feed>\n`
  );
}

/** Wrap a single rendered entry into a standalone Atom entry document. */
export function buildEntryDocument(entry: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n` +
    entry.replace("<entry>", `<entry xmlns="${ATOM_NS}" xmlns:d="${DS_NS}" xmlns:m="${M_NS}">`) +
    `\n`
  );
}
