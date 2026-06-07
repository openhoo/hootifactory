export { P2Adapter, p2RegistryPlugin } from "./p2-adapter";
export {
  type OsgiManifest,
  parseManifestHeaders,
  parseOsgiManifest,
} from "./p2-osgi-manifest";
export { handleP2Publish, P2_JAR_KIND } from "./p2-publish-lifecycle";
export {
  classifierForKind,
  dirForKind,
  hexDigest,
  isValidOsgiVersion,
  isValidSymbolicName,
  iuIdForUnit,
  JarFilenameSchema,
  jarFilename,
  OsgiVersionSchema,
  type P2ArtifactKind,
  P2ArtifactKindSchema,
  type P2VersionMeta,
  P2VersionMetaSchema,
  p2JarScope,
  parseP2VersionMeta,
  SymbolicNameSchema,
} from "./p2-validation";
export {
  buildArtifactsXml,
  buildContentXml,
  escapeXml,
  zipSingleEntry,
} from "./p2-xml";
