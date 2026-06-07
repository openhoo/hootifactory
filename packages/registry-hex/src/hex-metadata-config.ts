/**
 * A deliberately small parser for the Erlang term config that lives in a Hex
 * release tarball's `metadata.config`. The file is a flat sequence of
 * `{Key, Value}.` terms, e.g.:
 *
 *   {<<"name">>,<<"package1">>}.
 *   {<<"version">>,<<"1.0.0">>}.
 *   {<<"app">>,<<"package1">>}.
 *   {<<"licenses">>,[<<"MIT">>,<<"Apache-2.0">>]}.
 *   {<<"requirements">>,[[{<<"name">>,<<"poison">>},{<<"requirement">>,<<"~> 1.0">>}]]}.
 *
 * We model exactly the value shapes Hex emits for the keys we surface: binaries
 * (`<<"...">>`), lists of binaries, and (for `requirements`) a list of proplists.
 * Anything we cannot model is ignored — the raw tarball remains the source of
 * truth, and unknown/oddly-shaped keys are simply not extracted. There is no
 * external Erlang-term dependency, and the parser does not evaluate anything.
 */

export interface ParsedHexMetadataConfig {
  name?: string;
  version?: string;
  app?: string;
  description?: string;
  licenses?: string[];
  build_tools?: string[];
  requirements?: Record<string, string>;
}

/** A char-cursor tokenizer over the term config text. */
class Cursor {
  pos = 0;
  constructor(readonly text: string) {}

  skipWs(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === ",") {
        this.pos++;
        continue;
      }
      // Erlang `%` line comments.
      if (ch === "%") {
        while (this.pos < this.text.length && this.text[this.pos] !== "\n") this.pos++;
        continue;
      }
      break;
    }
  }

  peek(): string | undefined {
    return this.text[this.pos];
  }
}

type Term = string | Term[] | { proplist: Map<string, Term> };

/** Parse a single Erlang binary literal `<<"...">>` at the cursor, or null. */
function parseBinary(c: Cursor): string | null {
  if (!c.text.startsWith('<<"', c.pos)) return null;
  c.pos += 3;
  let out = "";
  while (c.pos < c.text.length) {
    const ch = c.text[c.pos];
    if (ch === "\\") {
      const next = c.text[c.pos + 1];
      out += next ?? "";
      c.pos += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    c.pos++;
  }
  // Consume closing `">>`.
  if (!c.text.startsWith('">>', c.pos)) return null;
  c.pos += 3;
  return out;
}

/** Parse any term (binary, list, tuple) at the cursor. Returns null on a shape we don't model. */
function parseTerm(c: Cursor): Term | null {
  c.skipWs();
  const ch = c.peek();
  if (ch === undefined) return null;
  if (ch === "<") return parseBinary(c);
  if (ch === "[") return parseList(c);
  if (ch === "{") return parseTuple(c);
  // Atoms/numbers/etc. we don't surface: skip the token so the outer loop can recover.
  skipToken(c);
  return null;
}

/** Skip an unmodeled token up to the next structural delimiter. */
function skipToken(c: Cursor): void {
  while (c.pos < c.text.length) {
    const ch = c.text[c.pos];
    if (ch === "," || ch === "]" || ch === "}" || ch === ".") break;
    c.pos++;
  }
}

function parseList(c: Cursor): Term[] | null {
  if (c.peek() !== "[") return null;
  c.pos++;
  const items: Term[] = [];
  while (true) {
    c.skipWs();
    if (c.peek() === "]") {
      c.pos++;
      return items;
    }
    if (c.peek() === undefined) return null;
    const before = c.pos;
    const term = parseTerm(c);
    if (term !== null) items.push(term);
    // `parseTerm` can stall on a stray delimiter (e.g. `}`/`.` inside a list);
    // force forward progress so a malformed term config cannot spin forever.
    if (c.pos === before) c.pos++;
  }
}

/** Parse a 2-tuple `{Key, Value}` as a proplist pair, or a longer tuple's pairs. */
function parseTuple(c: Cursor): { proplist: Map<string, Term> } | null {
  if (c.peek() !== "{") return null;
  c.pos++;
  const key = parseTerm(c);
  c.skipWs();
  const value = parseTerm(c);
  // Skip any remaining tuple elements up to the closing brace. Guarantee forward
  // progress: `parseTerm` returns without advancing on a stray `]`/`.`, which
  // would otherwise hang on malformed input like `{a,b,]`.
  while (c.pos < c.text.length && c.peek() !== "}") {
    const before = c.pos;
    parseTerm(c);
    c.skipWs();
    if (c.pos === before) c.pos++;
  }
  if (c.peek() === "}") c.pos++;
  const map = new Map<string, Term>();
  if (typeof key === "string" && value !== null) map.set(key, value);
  return { proplist: map };
}

function asString(term: Term | undefined): string | undefined {
  return typeof term === "string" ? term : undefined;
}

function asStringList(term: Term | undefined): string[] | undefined {
  if (!Array.isArray(term)) return undefined;
  const out = term.filter((t): t is string => typeof t === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * Merge a proplist value into a single map. The parser emits each `{Key, Value}`
 * tuple as its own single-pair `{proplist}` object, so a proplist literal
 * `[{<<"name">>,...},{<<"requirement">>,...}]` arrives as an *array* of those
 * single-pair objects (or, defensively, a lone object). This collapses either
 * shape into one keyed map.
 */
function mergeProplist(term: Term): Map<string, Term> {
  const out = new Map<string, Term>();
  const items = Array.isArray(term) ? term : [term];
  for (const item of items) {
    if (typeof item === "object" && item !== null && "proplist" in item) {
      for (const [k, v] of item.proplist) out.set(k, v);
    }
  }
  return out;
}

/** Map Hex's `requirements` (a list of proplists with `name`/`requirement`) to a flat map. */
function asRequirements(term: Term | undefined): Record<string, string> | undefined {
  if (!Array.isArray(term)) return undefined;
  const out: Record<string, string> = {};
  for (const item of term) {
    const props = mergeProplist(item);
    const name = asString(props.get("name"));
    const requirement = asString(props.get("requirement"));
    if (name && requirement !== undefined) out[name] = requirement;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse the top-level `{Key, Value}.` terms of a Hex `metadata.config`. */
export function parseHexMetadataConfig(text: string): ParsedHexMetadataConfig {
  const c = new Cursor(text);
  const top = new Map<string, Term>();
  while (c.pos < c.text.length) {
    c.skipWs();
    if (c.peek() === undefined) break;
    if (c.peek() !== "{") {
      // Not a top-level tuple — skip to the next statement terminator and retry.
      while (c.pos < c.text.length && c.peek() !== ".") c.pos++;
      c.pos++;
      continue;
    }
    const tuple = parseTuple(c);
    if (tuple) {
      for (const [k, v] of tuple.proplist) top.set(k, v);
    }
    // Consume the trailing `.` statement terminator.
    c.skipWs();
    if (c.peek() === ".") c.pos++;
  }

  const result: ParsedHexMetadataConfig = {};
  const name = asString(top.get("name"));
  const version = asString(top.get("version"));
  const app = asString(top.get("app"));
  const description = asString(top.get("description"));
  const licenses = asStringList(top.get("licenses"));
  const buildTools = asStringList(top.get("build_tools"));
  const requirements = asRequirements(top.get("requirements"));
  if (name !== undefined) result.name = name;
  if (version !== undefined) result.version = version;
  if (app !== undefined) result.app = app;
  if (description !== undefined) result.description = description;
  if (licenses !== undefined) result.licenses = licenses;
  if (buildTools !== undefined) result.build_tools = buildTools;
  if (requirements !== undefined) result.requirements = requirements;
  return result;
}
