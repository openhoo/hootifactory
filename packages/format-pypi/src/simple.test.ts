import { describe, expect, test } from "bun:test";
import {
  isSafeDistributionFilename,
  isValidProjectName,
  LEGACY_HTML_CONTENT_TYPE,
  normalizeName,
  preferredSimpleResponse,
  renderProjectHtml,
  renderRootHtml,
  SIMPLE_HTML_CONTENT_TYPE,
  SIMPLE_JSON_CONTENT_TYPE,
  simpleHtmlContentType,
} from "./simple";

describe("PyPI simple API rendering", () => {
  test("normalizes project names according to PEP 503", () => {
    expect(normalizeName("My_Pkg.Name")).toBe("my-pkg-name");
    expect(normalizeName("already-normal")).toBe("already-normal");
  });

  test("validates project names and distribution filenames before storage", () => {
    expect(isValidProjectName("My_Pkg.Name")).toBe(true);
    expect(isValidProjectName("bad/name")).toBe(false);
    expect(isValidProjectName("../pkg")).toBe(false);
    expect(isSafeDistributionFilename("pkg-1.0.0-py3-none-any.whl")).toBe(true);
    expect(isSafeDistributionFilename("pkg/1.0.0.whl")).toBe(false);
    expect(isSafeDistributionFilename("pkg\\1.0.0.whl")).toBe(false);
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

  test("selects simple JSON only when its accept weight wins", () => {
    expect(preferredSimpleResponse(null)).toBe("html");
    expect(preferredSimpleResponse(`${SIMPLE_JSON_CONTENT_TYPE}; q=0.5, text/html; q=0.4`)).toBe(
      "json",
    );
    expect(preferredSimpleResponse("application/json, text/html")).toBe("json");
    expect(preferredSimpleResponse(`${SIMPLE_JSON_CONTENT_TYPE}; q=0, text/html; q=1`)).toBe(
      "html",
    );
    expect(preferredSimpleResponse(`${SIMPLE_JSON_CONTENT_TYPE}; q=0.2, */*; q=0.9`)).toBe("html");
  });

  test("keeps vendor HTML content type for simple API accept headers", () => {
    expect(simpleHtmlContentType(`${SIMPLE_JSON_CONTENT_TYPE}; q=0`)).toBe(
      SIMPLE_HTML_CONTENT_TYPE,
    );
    expect(simpleHtmlContentType("text/html")).toBe(LEGACY_HTML_CONTENT_TYPE);
  });
});
