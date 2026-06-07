import type { OpamDepend, OpamVersionMeta } from "./opam-validation";

/**
 * A minimal serializer for the opam file format (`opam-version: "2.0"`).
 * Produces the subset of fields hootifactory hosts: name, version, maintainer,
 * homepage, license, synopsis, depends, and the `url { src checksum }` section.
 *
 * The format is line-based: scalar fields are `field: "value"`, list fields are
 * `field: [ "a" "b" ]`, and sections are `name { ... }`. opam string literals are
 * double-quoted with backslash escaping.
 */

/** Quote and escape a string as an opam string literal. */
export function opamString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Render a single `depends:` formula entry: `"name"` or `"name" { constraint }`. */
export function opamDepend(dep: OpamDepend): string {
  const name = opamString(dep.name);
  const constraint = dep.constraint?.trim();
  return constraint ? `${name} { ${constraint} }` : name;
}

export interface OpamUrlSection {
  /** Absolute URL to the source archive. */
  src: string;
  /** Bare hex sha256 of the source archive (no `sha256=` prefix). */
  sha256: string;
}

export interface OpamFileInput {
  name: string;
  version: string;
  maintainer?: string;
  homepage?: string;
  license?: string;
  synopsis?: string;
  depends?: OpamDepend[];
  url?: OpamUrlSection;
}

/** Serialize an opam package-definition file. */
export function serializeOpamFile(input: OpamFileInput): string {
  const lines: string[] = [];
  lines.push('opam-version: "2.0"');
  lines.push(`name: ${opamString(input.name)}`);
  lines.push(`version: ${opamString(input.version)}`);
  if (input.maintainer !== undefined) {
    lines.push(`maintainer: ${opamString(input.maintainer)}`);
  }
  if (input.homepage !== undefined) {
    lines.push(`homepage: ${opamString(input.homepage)}`);
  }
  if (input.license !== undefined) {
    lines.push(`license: ${opamString(input.license)}`);
  }
  if (input.synopsis !== undefined) {
    lines.push(`synopsis: ${opamString(input.synopsis)}`);
  }
  if (input.depends && input.depends.length > 0) {
    lines.push(`depends: [ ${input.depends.map(opamDepend).join(" ")} ]`);
  }
  if (input.url) {
    lines.push("url {");
    lines.push(`  src: ${opamString(input.url.src)}`);
    lines.push(`  checksum: [ ${opamString(`sha256=${input.url.sha256}`)} ]`);
    lines.push("}");
  }
  return `${lines.join("\n")}\n`;
}

/** Build the opam file body for a stored version, pointing `url.src` at `srcUrl`. */
export function buildOpamFile(meta: OpamVersionMeta, srcUrl: string): string {
  return serializeOpamFile({
    name: meta.name,
    version: meta.version,
    maintainer: meta.maintainer,
    homepage: meta.homepage,
    license: meta.license,
    synopsis: meta.synopsis,
    depends: meta.depends,
    url: { src: srcUrl, sha256: meta.sha256 },
  });
}
