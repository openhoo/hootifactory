export interface SimpleFile {
  filename: string;
  url: string;
  sha256: string;
  requiresPython?: string;
}

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

/** PEP 503 name normalization. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}
