import { describe, expect, test } from "bun:test";
import { parseHexMetadataConfig } from "./hex-metadata-config";

describe("Hex metadata.config parser", () => {
  test("parses the well-known scalar + list + requirements keys", () => {
    const text = [
      '{<<"name">>,<<"demo">>}.',
      '{<<"app">>,<<"demo">>}.',
      '{<<"version">>,<<"1.2.3">>}.',
      '{<<"description">>,<<"a demo package">>}.',
      '{<<"licenses">>,[<<"MIT">>,<<"Apache-2.0">>]}.',
      '{<<"build_tools">>,[<<"mix">>,<<"rebar3">>]}.',
      '{<<"requirements">>,[[{<<"name">>,<<"poison">>},{<<"app">>,<<"poison">>},{<<"requirement">>,<<"~> 1.0">>},{<<"optional">>,false}],[{<<"name">>,<<"jason">>},{<<"requirement">>,<<">= 1.0.0">>}]]}.',
    ].join("\n");
    expect(parseHexMetadataConfig(text)).toEqual({
      name: "demo",
      app: "demo",
      version: "1.2.3",
      description: "a demo package",
      licenses: ["MIT", "Apache-2.0"],
      build_tools: ["mix", "rebar3"],
      requirements: { poison: "~> 1.0", jason: ">= 1.0.0" },
    });
  });

  test("ignores unknown keys and oddly-shaped values without throwing", () => {
    const text = [
      '{<<"name">>,<<"demo">>}.',
      '{<<"version">>,<<"1.0.0">>}.',
      '{<<"app">>,<<"demo">>}.',
      '{<<"elixir">>,<<"~> 1.14">>}.',
      '{<<"maintainers">>,[<<"Alice">>]}.',
      '{<<"files">>,[<<"lib">>,<<"mix.exs">>]}.',
      '{<<"some_atom_value">>,undefined}.',
    ].join("\n");
    const parsed = parseHexMetadataConfig(text);
    expect(parsed.name).toBe("demo");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.app).toBe("demo");
    // Unknown keys are simply not surfaced.
    expect("maintainers" in parsed).toBe(false);
    expect("files" in parsed).toBe(false);
  });

  test("handles escaped quotes inside a binary", () => {
    const text = '{<<"description">>,<<"a \\"quoted\\" word">>}.\n{<<"name">>,<<"demo">>}.';
    const parsed = parseHexMetadataConfig(text);
    expect(parsed.description).toBe('a "quoted" word');
    expect(parsed.name).toBe("demo");
  });

  test("returns an empty object for unrelated text", () => {
    expect(parseHexMetadataConfig("garbage without terms")).toEqual({});
    expect(parseHexMetadataConfig("")).toEqual({});
  });

  test("drops requirements entries that lack a name or requirement", () => {
    const text =
      '{<<"requirements">>,[[{<<"app">>,<<"x">>}],[{<<"name">>,<<"ok">>},{<<"requirement">>,<<"1.0">>}]]}.';
    expect(parseHexMetadataConfig(text).requirements).toEqual({ ok: "1.0" });
  });

  test("terminates on malformed list/tuple input (no infinite loop)", () => {
    // A stray delimiter inside a list/tuple would stall a non-progressing parser.
    // Each of these must return promptly (the test runner would otherwise hang).
    for (const text of [
      '{<<"licenses">>,[}]}.',
      '{<<"licenses">>,[.]}.',
      '{<<"name">>,<<"demo">>,]}.',
      '{<<"requirements">>,[[}]]}.\n{<<"name">>,<<"demo">>}.',
      "[[[[",
      "{{{{",
    ]) {
      expect(() => parseHexMetadataConfig(text)).not.toThrow();
    }
    // Recovery still extracts a well-formed term that follows malformed input.
    expect(parseHexMetadataConfig('{<<"licenses">>,[}]}.\n{<<"name">>,<<"demo">>}.').name).toBe(
      "demo",
    );
  });
});
