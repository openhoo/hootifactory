/**
 * Debian control-stanza helpers. The `control` file is RFC822-ish: `Field: value`
 * with space/tab-prefixed continuation lines folded into the previous field, and
 * a blank line terminating the stanza.
 */

export function parseControlFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      key = null;
      continue;
    }
    if ((line[0] === " " || line[0] === "\t") && key) {
      fields[key] += `\n${line}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) {
      key = null;
      continue;
    }
    key = line.slice(0, idx).trim();
    fields[key] = line.slice(idx + 1).replace(/^ /, "");
  }
  return fields;
}

/** Bare dependency names from a `Depends:` value (first alternative, no version/arch). */
export function parseDepends(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) =>
      (part.split("|")[0] ?? "")
        .trim()
        .replace(/\s*\([^)]*\)/g, "")
        .replace(/:[A-Za-z0-9-]+/g, "")
        .trim(),
    )
    .filter(Boolean);
}
