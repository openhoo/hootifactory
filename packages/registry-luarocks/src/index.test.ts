import { describe, expect, test } from "bun:test";
import * as luarocks from "./index";

describe("registry-luarocks package entry", () => {
  test("re-exports the adapter, plugin instance, and helpers", () => {
    expect(typeof luarocks.LuarocksAdapter).toBe("function");
    expect(luarocks.luarocksRegistryPlugin).toBeInstanceOf(luarocks.LuarocksAdapter);
    expect(typeof luarocks.buildLuarocksManifest).toBe("function");
    expect(typeof luarocks.quoteLuaString).toBe("function");
    expect(typeof luarocks.versionEntryFromMeta).toBe("function");
    expect(typeof luarocks.handleLuarocksPublish).toBe("function");
    expect(luarocks.LUAROCKS_BLOB_KIND).toBeTruthy();
    expect(typeof luarocks.luarocksBlobScope).toBe("function");
    expect(typeof luarocks.parseRockspec).toBe("function");
    expect(typeof luarocks.parseArtifactFilename).toBe("function");
  });
});
