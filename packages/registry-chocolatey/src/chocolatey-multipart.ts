/**
 * Chocolatey speaks the NuGet push protocol: `choco push` (NuGet client) sends
 * the .nupkg as a single multipart part. We delegate to the shared registry SDK,
 * whose default "first part bearing a content-disposition" rule matches the
 * original local behavior. Kept as a thin wrapper so the consumer's imports are
 * unchanged.
 */
export { extractMultipartFile, MultipartContentTypeSchema } from "@hootifactory/registry";
