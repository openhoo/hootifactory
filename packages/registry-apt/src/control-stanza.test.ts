import { describe, expect, test } from "bun:test";
import { parseControlFields, parseDepends } from "./control-stanza";

const CONTROL = `Package: hootpkg
Version: 1.0.0
Architecture: amd64
Maintainer: e2e <e2e@hooti.test>
Depends: libc6 (>= 2.2.5), libfoo:amd64 | libbar
Description: a short summary
 a long line
 another long line`;

describe("control stanza", () => {
  test("parses fields and folds continuation lines", () => {
    const fields = parseControlFields(CONTROL);
    expect(fields.Package).toBe("hootpkg");
    expect(fields.Version).toBe("1.0.0");
    expect(fields.Architecture).toBe("amd64");
    expect(fields.Description).toBe("a short summary\n a long line\n another long line");
  });

  test("parseDepends takes the first alternative, dropping versions and arch", () => {
    expect(parseDepends("libc6 (>= 2.2.5), libfoo:amd64 | libbar, zlib1g")).toEqual([
      "libc6",
      "libfoo",
      "zlib1g",
    ]);
    expect(parseDepends(undefined)).toEqual([]);
  });
});
