export interface VagrantPublishError {
  error: string;
  status: number;
}

export interface VagrantPublishPlan {
  user: string;
  box: string;
  version: string;
  provider: string;
  /**
   * The raw `.box` artifact body (the PUT request stream). `.box` files are
   * commonly large, so the body is streamed into storage rather than buffered.
   */
  artifact: ReadableStream<Uint8Array>;
}

export type VagrantPublishParseResult =
  | { ok: true; plan: VagrantPublishPlan }
  | { ok: false; error: VagrantPublishError };

/**
 * Parse a `PUT /:user/:box/:version/:provider` publish. The path supplies the box
 * coordinates (validated by the publish route's `.params()` schemas before this
 * runs); the request body is the raw `.box` artifact, streamed into storage
 * rather than buffered into memory. A missing body is rejected here; an empty
 * stream is caught after storage by the lifecycle (a box must carry bytes).
 */
export function parseVagrantPublishRequest(
  user: string,
  box: string,
  version: string,
  provider: string,
  req: Request,
): VagrantPublishParseResult {
  if (!req.body) {
    return { ok: false, error: { error: "empty box artifact", status: 400 } };
  }

  return { ok: true, plan: { user, box, version, provider, artifact: req.body } };
}
