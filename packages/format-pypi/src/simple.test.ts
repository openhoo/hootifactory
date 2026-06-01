import { describe, expect, test } from "bun:test";
import { normalizeName, renderProjectHtml, renderRootHtml } from "./simple";

describe("PyPI simple API rendering", () => {
  test("normalizes project names according to PEP 503", () => {
    expect(normalizeName("My_Pkg.Name")).toBe("my-pkg-name");
    expect(normalizeName("already-normal")).toBe("already-normal");
  });

  test("escapes project page filenames, URLs, and python requirements", () => {
    const html = renderProjectHtml("pkg<name>", [
      {
        filename: "pkg<name>-1.0.0.tar.gz",
        url: "https://repo.test/files/pkg?x=<tag>&y=1",
        sha256: "abc123",
        requiresPython: ">=3.11,<4",
      },
    ]);

    expect(html).toContain("<title>Links for pkg&lt;name&gt;</title>");
    expect(html).toContain(
      '<a href="https://repo.test/files/pkg?x=&lt;tag&gt;&amp;y=1#sha256=abc123" data-requires-python="&gt;=3.11,&lt;4">pkg&lt;name&gt;-1.0.0.tar.gz</a>',
    );
  });

  test("renders a sorted root index supplied by the caller", () => {
    const html = renderRootHtml(["alpha", "beta"]);

    expect(html).toContain('<a href="alpha/">alpha</a>');
    expect(html).toContain('<a href="beta/">beta</a>');
    expect(html).toContain('content="1.0"');
  });
});
