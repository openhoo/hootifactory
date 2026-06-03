interface OciUploadLocationContext {
  baseUrl: string;
  repo: { mountPath: string };
}

interface OciUploadLocationInput {
  ctx: OciUploadLocationContext;
  image: string;
}

interface OciBlobLocationInput extends OciUploadLocationInput {
  digest: string;
}

interface OciUploadPathInput extends OciUploadLocationInput {
  uuid: string;
}

interface OciUploadResponseInput extends OciUploadPathInput {
  offset: number;
}

interface OciUploadCommitResponseInput extends OciBlobLocationInput {
  size: number;
}

export function buildOciBlobCreatedResponse(input: OciBlobLocationInput): Response {
  return new Response(null, {
    status: 201,
    headers: {
      location: ociBlobLocation(input),
      "docker-content-digest": input.digest,
      "content-length": "0",
    },
  });
}

export function buildOciUploadAcceptedResponse(input: OciUploadResponseInput): Response {
  return new Response(null, {
    status: 202,
    headers: {
      location: ociUploadLocation(input),
      range: ociUploadRange(input.offset),
      "docker-upload-uuid": input.uuid,
      "content-length": "0",
    },
  });
}

export function buildOciUploadStatusResponse(input: OciUploadResponseInput): Response {
  return new Response(null, {
    status: 204,
    headers: {
      range: ociUploadRange(input.offset),
      "docker-upload-uuid": input.uuid,
      location: ociUploadLocation(input),
    },
  });
}

export function buildOciUploadCommittedResponse(input: OciUploadCommitResponseInput): Response {
  const range = ociUploadRange(input.size);
  return new Response(null, {
    status: 201,
    headers: {
      location: ociBlobLocation(input),
      "docker-content-digest": input.digest,
      "content-length": "0",
      "content-range": range,
      range,
    },
  });
}

export function ociUploadLocation(input: OciUploadPathInput): string {
  return `${input.ctx.baseUrl}/${input.ctx.repo.mountPath}/${input.image}/blobs/uploads/${input.uuid}`;
}

export function ociBlobLocation(input: OciBlobLocationInput): string {
  return `${input.ctx.baseUrl}/${input.ctx.repo.mountPath}/${input.image}/blobs/${input.digest}`;
}

export function ociUploadRange(offset: number): string {
  return `0-${Math.max(0, offset - 1)}`;
}
