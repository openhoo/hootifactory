import { createHash, createHmac } from "node:crypto";
import { trimChar } from "@hootifactory/core";

function encodeS3Path(value: string): string {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function joinUrlPath(...parts: string[]): string {
  return `/${parts
    .map((part) => trimChar(part, "/"))
    .filter(Boolean)
    .join("/")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacSha256Hex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secretAccessKey: string, date: string, region: string): Buffer {
  const dateKey = hmacSha256(`AWS4${secretAccessKey}`, date);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, "s3");
  return hmacSha256(serviceKey, "aws4_request");
}

export function signedCopyObjectRequest(input: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  sourceKey: string;
  targetKey: string;
}): { url: string; headers: Record<string, string> } {
  const endpoint = new URL(input.endpoint);
  const basePath = endpoint.pathname === "/" ? "" : endpoint.pathname;
  const targetPath = encodeS3Path(input.targetKey);
  const bucketPath = encodeURIComponent(input.bucket);
  const pathname = input.forcePathStyle
    ? joinUrlPath(basePath, bucketPath, targetPath)
    : joinUrlPath(basePath, targetPath);
  const host = input.forcePathStyle ? endpoint.host : `${input.bucket}.${endpoint.host}`;
  const url = new URL(endpoint.toString());
  url.host = host;
  url.pathname = pathname;
  url.search = "";

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const copySource = `/${encodeURIComponent(input.bucket)}/${encodeS3Path(input.sourceKey)}`;
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-copy-source": copySource,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}:${value.trim()}\n`)
    .join("");
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacSha256Hex(
    signingKey(input.secretAccessKey, date, input.region),
    stringToSign,
  );

  return {
    url: url.toString(),
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
