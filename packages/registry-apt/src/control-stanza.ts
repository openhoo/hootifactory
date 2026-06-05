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
    const value = line.slice(idx + 1);
    fields[key] = value.startsWith(" ") ? value.slice(1) : value;
  }
  return fields;
}

function stripParenGroups(value: string): string {
  let out = "";
  let depth = 0;
  for (const char of value) {
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

/** Bare dependency names from a `Depends:` value (first alternative, no version/arch). */
export function parseDepends(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => {
      const name = stripParenGroups(part.split("|")[0] ?? "").trim();
      const colon = name.indexOf(":");
      return (colon >= 0 ? name.slice(0, colon) : name).trim();
    })
    .filter(Boolean);
}
