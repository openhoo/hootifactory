import { parseRegistryInput } from "@hootifactory/registry";
import {
  VagrantNameSegmentSchema,
  VagrantProviderSchema,
  VagrantVersionSchema,
} from "./vagrant-validation";

export interface VagrantPublishError {
  error: string;
  status: number;
}

export interface VagrantPublishPlan {
  user: string;
  box: string;
  version: string;
  provider: string;
  /** The raw `.box` artifact bytes (the PUT request body). */
  artifact: Uint8Array;
}

export type VagrantPublishParseResult =
  | { ok: true; plan: VagrantPublishPlan }
  | { ok: false; error: VagrantPublishError };

function parseUser(user: string): string {
  return parseRegistryInput(VagrantNameSegmentSchema, user, {
    code: "NAME_INVALID",
    message: "invalid Vagrant box user",
  });
}

function parseBox(box: string): string {
  return parseRegistryInput(VagrantNameSegmentSchema, box, {
    code: "NAME_INVALID",
    message: "invalid Vagrant box name",
  });
}

function parseVersion(version: string): string {
  return parseRegistryInput(VagrantVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid Vagrant box version",
  });
}

function parseProvider(provider: string): string {
  return parseRegistryInput(VagrantProviderSchema, provider, {
    code: "NAME_INVALID",
    message: "invalid Vagrant provider name",
  });
}

/**
 * Parse a `PUT /:user/:box/:version/:provider` publish. The path supplies the box
 * coordinates; the request body is the raw `.box` artifact. An empty body is
 * rejected — a box must carry bytes.
 */
export async function parseVagrantPublishRequest(
  userRaw: string,
  boxRaw: string,
  versionRaw: string,
  providerRaw: string,
  req: Request,
): Promise<VagrantPublishParseResult> {
  const user = parseUser(userRaw);
  const box = parseBox(boxRaw);
  const version = parseVersion(versionRaw);
  const provider = parseProvider(providerRaw);

  const artifact = new Uint8Array(await req.arrayBuffer());
  if (artifact.length === 0) {
    return { ok: false, error: { error: "empty box artifact", status: 400 } };
  }

  return { ok: true, plan: { user, box, version, provider, artifact } };
}
