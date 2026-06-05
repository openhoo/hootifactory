import { describe, expect, test } from "bun:test";
import { readComposerManifest } from "./composer-zip";
import { composerJsonEntry, makeStoreZip } from "./composer-zip.fixtures";

describe("readComposerManifest", () => {
  test("reads name, version, type, and require from the root composer.json", () => {
    const zip = makeStoreZip([
      composerJsonEntry({
        name: "acme/widget",
        version: "1.2.3",
        type: "library",
        require: { php: ">=8.1", "acme/core": "^1.0" },
      }),
      { name: "src/Widget.php", data: new TextEncoder().encode("<?php") },
    ]);
    expect(readComposerManifest(zip)).toEqual({
      name: "acme/widget",
      version: "1.2.3",
      type: "library",
      require: { php: ">=8.1", "acme/core": "^1.0" },
    });
  });

  test("prefers the shallowest composer.json", () => {
    const zip = makeStoreZip([
      { name: "vendor/dep/composer.json", data: new TextEncoder().encode('{"name":"vendor/dep"}') },
      composerJsonEntry({ name: "acme/widget" }),
    ]);
    expect(readComposerManifest(zip)?.name).toBe("acme/widget");
  });

  test("returns null when no composer.json is present", () => {
    const zip = makeStoreZip([{ name: "readme.txt", data: new TextEncoder().encode("hi") }]);
    expect(readComposerManifest(zip)).toBeNull();
  });
});
