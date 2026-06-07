/**
 * Debian-control-style (RFC822-ish) field helpers, shared by the DESCRIPTION
 * parser (publish) and the PACKAGES index serializer (read). Fields are
 * `Field: value`; space/tab-prefixed continuation lines fold into the previous
 * field, and a blank line terminates a stanza. CRAN's DESCRIPTION and PACKAGES
 * files both use this format.
 */

/** Parse a single control stanza into an ordered field map. */
export function parseControlFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.split("\n")) {
    // A `\r` is folded away so CRLF DESCRIPTION files parse identically.
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (raw.trim() === "") {
      // A blank line ends the first stanza; DESCRIPTION has only one.
      if (key !== null) break;
      continue;
    }
    if ((raw[0] === " " || raw[0] === "\t") && key) {
      fields[key] += `\n${raw}`;
      continue;
    }
    const idx = raw.indexOf(":");
    if (idx < 0) {
      key = null;
      continue;
    }
    key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1);
    fields[key] = value.startsWith(" ") ? value.slice(1) : value;
  }
  return fields;
}

/**
 * Serialize ordered `[field, value]` pairs into one control stanza. Multi-line
 * values (already containing folded continuation lines) are emitted verbatim;
 * empty values are skipped so a `PACKAGES` stanza never carries blank fields.
 */
export function serializeControlStanza(fields: Array<[string, string]>): string {
  return fields
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/**
 * Bare dependency names from a `Depends:`/`Imports:`/`LinkingTo:`/`Suggests:`
 * value (no version constraints). CRAN dependency lists are comma-separated
 * `name (>= x.y)` entries; the parenthesized constraint is dropped. The pseudo
 * package `R` (a version floor on the R interpreter) is kept as a name.
 */
export function parseDependencyNames(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.replace(/\([^)]*\)/g, "").trim())
    .filter(Boolean);
}
