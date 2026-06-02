export interface SimpleFile {
  filename: string;
  url: string;
  sha256: string;
  requiresPython?: string;
  size?: number;
  uploadTime?: string;
}

export const SIMPLE_JSON_CONTENT_TYPE = "application/vnd.pypi.simple.v1+json";
export const SIMPLE_HTML_CONTENT_TYPE = "application/vnd.pypi.simple.v1+html; charset=utf-8";
export const LEGACY_HTML_CONTENT_TYPE = "text/html; charset=utf-8";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** PEP 503 project page. */
export function renderProjectHtml(project: string, files: SimpleFile[]): string {
  const links = files
    .map((f) => {
      const rp = f.requiresPython ? ` data-requires-python="${escapeHtml(f.requiresPython)}"` : "";
      return `    <a href="${escapeHtml(f.url)}#sha256=${f.sha256}"${rp}>${escapeHtml(f.filename)}</a><br/>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="pypi:repository-version" content="1.0" />
    <title>Links for ${escapeHtml(project)}</title>
  </head>
  <body>
    <h1>Links for ${escapeHtml(project)}</h1>
${links}
  </body>
</html>
`;
}

/** PEP 503 root index. */
export function renderRootHtml(projects: string[]): string {
  const links = projects
    .map((p) => `    <a href="${escapeHtml(p)}/">${escapeHtml(p)}</a><br/>`)
    .join("\n");
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="pypi:repository-version" content="1.0" />
    <title>Simple index</title>
  </head>
  <body>
${links}
  </body>
</html>
`;
}

export function preferredSimpleResponse(acceptHeader: string | null): "json" | "html" {
  const accept = acceptHeader ?? "";
  const weighted = accept.split(",").map((part) => {
    const [media = "", ...params] = part.trim().split(";");
    const qParam = params.find((param) => param.trim().startsWith("q="));
    const q = qParam ? Number.parseFloat(qParam.split("=", 2)[1] ?? "0") : 1;
    return { media: media.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
  });
  const jsonQ =
    weighted.find((part) => part.media === SIMPLE_JSON_CONTENT_TYPE)?.q ??
    weighted.find((part) => part.media === "application/json")?.q ??
    0;
  const htmlQ =
    Math.max(
      weighted.find((part) => part.media === "text/html")?.q ?? 0,
      weighted.find((part) => part.media === "application/vnd.pypi.simple.v1+html")?.q ?? 0,
      weighted.find((part) => part.media === "*/*")?.q ?? 0,
    ) || (accept ? 0 : 1);
  return jsonQ > 0 && jsonQ >= htmlQ ? "json" : "html";
}

export function simpleHtmlContentType(acceptHeader: string | null): string {
  return (acceptHeader ?? "").toLowerCase().includes("application/vnd.pypi.simple")
    ? SIMPLE_HTML_CONTENT_TYPE
    : LEGACY_HTML_CONTENT_TYPE;
}

/** PEP 503 name normalization. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Core Metadata project names: ASCII alnum with internal dot/underscore/hyphen separators. */
export function isValidProjectName(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name);
}

export function isSafeDistributionFilename(filename: string): boolean {
  return (
    Boolean(filename) &&
    /^[A-Za-z0-9][A-Za-z0-9._+!-]*$/.test(filename) &&
    !filename.includes("/") &&
    !filename.includes("\\")
  );
}
