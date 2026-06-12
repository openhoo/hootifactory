import type { RegistryRequestContext } from "@hootifactory/registry";
import { parseControlFields, parseDepends } from "./control-stanza";
import { parseDeb } from "./deb-parse";

/** Blob/asset kind for stored `.deb` files; the scope is the pool path. */
export const APT_DEB_KIND = "apt_deb";

export async function handleAptUpload(input: {
  poolPath: string;
  suite: string;
  component: string;
  req: Request;
  ctx: RegistryRequestContext;
}): Promise<Response> {
  const { poolPath, suite, component, req, ctx } = input;
  const bytes = new Uint8Array(await req.arrayBuffer());
  const parsed = parseDeb(bytes);
  if (!parsed.ok) {
    if (parsed.reason === "unsupported_compression") {
      return new Response(
        "control.tar.{xz,zst} is unsupported; rebuild the .deb with `dpkg-deb -Zgzip`",
        { status: 415 },
      );
    }
    return new Response("malformed .deb archive", { status: 422 });
  }

  const fields = parseControlFields(parsed.info.controlText);
  const name = fields.Package;
  const version = fields.Version;
  const architecture = fields.Architecture;
  if (!name || !version || !architecture) {
    return new Response("control is missing Package/Version/Architecture", { status: 422 });
  }

  if (
    await ctx.data.assets.findByScope({ role: APT_DEB_KIND, scope: poolPath, includeDeleted: true })
  ) {
    return new Response("pool file already exists", { status: 409 });
  }

  const stored = await ctx.data.content.storeBlobWithRef({
    data: bytes,
    kind: APT_DEB_KIND,
    scope: poolPath,
    mediaType: "application/vnd.debian.binary-package",
  });
  const pkg = await ctx.data.packages.findOrCreate({ name });
  await ctx.data.versions.upsert({
    package: pkg,
    version,
    metadata: {
      architecture,
      deps: parseDepends(fields.Depends),
      suite,
      component,
      debDigest: stored.digest,
    },
    sizeBytes: bytes.byteLength,
  });
  await ctx.data.assets.upsert({
    digest: stored.digest,
    blobRefId: stored.blobRefId,
    role: APT_DEB_KIND,
    scope: poolPath,
    path: poolPath,
    mediaType: "application/vnd.debian.binary-package",
    sizeBytes: bytes.byteLength,
    package: pkg,
    metadata: {
      controlText: parsed.info.controlText,
      md5: parsed.info.md5,
      sha256: parsed.info.sha256,
      debSize: bytes.byteLength,
      package: name,
      version,
      architecture,
      suite,
      component,
    },
    scanInput: {
      digest: stored.digest,
      name,
      version,
      mediaType: "application/vnd.debian.binary-package",
    },
  });
  return new Response(null, { status: 201 });
}
