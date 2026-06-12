import { parseRegistryInput } from "@hootifactory/registry";
import { type HomebrewFormulaInfo, HomebrewFormulaInfoSchema } from "./homebrew-validation";

export type HomebrewPublishError = {
  error: string;
  status: 400;
};

export interface HomebrewPublishPlan {
  name: string;
  version: string;
  tag: string;
  bottle: File;
  info: HomebrewFormulaInfo;
}

export type HomebrewPublishPlanResult =
  | { ok: true; plan: HomebrewPublishPlan }
  | { ok: false; error: HomebrewPublishError };

/**
 * Parse a bottle-publish request: multipart/form-data with a required `bottle`
 * file part (the tar.gz) and an optional `formula` JSON part carrying
 * descriptive metadata. The formula name/version/tag come from the URL path
 * (validated by the publish route's `.params()` schemas before this runs).
 */
export async function parseHomebrewPublishRequest(
  name: string,
  version: string,
  tag: string,
  req: Request,
): Promise<HomebrewPublishPlanResult> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return { ok: false, error: { error: "expected multipart/form-data", status: 400 } };
  }

  const form = await req.formData().catch(() => null);
  if (!form) return { ok: false, error: { error: "invalid multipart body", status: 400 } };

  const bottle = form.get("bottle");
  if (!(bottle instanceof File)) {
    return { ok: false, error: { error: "missing bottle file part", status: 400 } };
  }

  const info = parseFormulaInfo(form.get("formula"));
  if (!info.ok) return info;

  return { ok: true, plan: { name, version, tag, bottle, info: info.value } };
}

function parseFormulaInfo(
  raw: File | string | null,
): { ok: true; value: HomebrewFormulaInfo } | { ok: false; error: HomebrewPublishError } {
  if (raw === null) return { ok: true, value: {} };
  // The `formula` part must arrive as a plain JSON text field, not a file upload.
  if (typeof raw !== "string") {
    return { ok: false, error: { error: "formula part must be JSON text", status: 400 } };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: { error: "formula part is not valid JSON", status: 400 } };
  }
  const value = parseRegistryInput(HomebrewFormulaInfoSchema, decoded, {
    code: "MANIFEST_INVALID",
    message: "invalid formula metadata",
  });
  return { ok: true, value };
}
