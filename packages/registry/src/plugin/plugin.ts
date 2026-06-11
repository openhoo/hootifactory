// Barrel for the registry plugin SDK: re-exports the public plugin-authoring
// surface from the focused modules under ./plugin.
export {
  type RegistryAdapterAppRouteDsl,
  type RegistryAdapterAppRouteList,
  type RegistryAdapterAroundHandleHook,
  type RegistryAdapterAuthDsl,
  type RegistryAdapterBeforeHandleHook,
  RegistryAdapterBuilder,
  type RegistryAdapterClass,
  type RegistryAdapterDefaultPermission,
  type RegistryAdapterDefinition,
  type RegistryAdapterGenerateMetadata,
  type RegistryAdapterInstance,
  type RegistryAdapterMergeMetadata,
  type RegistryAdapterModuleDsl,
  type RegistryAdapterPermissionDsl,
  type RegistryAdapterPermissionInput,
  type RegistryAdapterPermissionResolver,
  type RegistryAdapterProxyIngest,
  RegistryAdapterRouteBuilder,
  type RegistryAdapterRouteDsl,
  type RegistryAdapterRouteHandler,
  type RegistryAdapterRouteInput,
  type RegistryAdapterRouteOptions,
  type RegistryAdapterSearch,
  type RegistryAdapterStateClass,
  type RegistryAdapterStateDsl,
  type RegistryAdapterStateFactory,
  type RegistryAdapterVirtualSearch,
  type RegistryPluginModuleInput,
  registryAdapter,
} from "./adapter-builder";
export {
  type RegistryAppRouteDsl,
  type RegistryAppRouteFactory,
  type RegistryAppRouteHandler,
  type RegistryAppRouteList,
  registryAppRouteDsl,
  registryAppRoutes,
} from "./app-routes-dsl";
export { type RegistryCapabilityFlag, registryCapabilities } from "./capabilities";
export { type DefineRegistryPluginInput, defineRegistryPlugin } from "./define-plugin";
export {
  artifactPermission,
  deletePermission,
  packagePermission,
  type RegistryArtifactPermissionParamOptions,
  type RegistryArtifactRuleOptions,
  type RegistryPackageRuleOptions,
  type RegistryPermissionParamOptions,
  type RegistryPermissionRule,
  readOnlyPermission,
  registryPermissions,
  routePermission,
  writePermission,
} from "./permissions";
export type {
  RegistryBeforeHandleHook,
  RegistryPermissionInput,
  RegistryPermissionResolver,
  RegistryRouteDsl,
  RegistryRouteFactory,
  RegistryRouteHandler,
  RegistryRouteInput,
  RegistryRouteList,
  RegistryRouteOptions,
  RegistryRouteParamSchemas,
  RegistryRouteParams,
  RegistryRoutePrefixFactory,
  RegistryRouteSpec,
} from "./route-types";
export { registryRoute, registryRoutes } from "./routes-dsl";
export { type RegistryScanDsl, type RegistryScanInput, registryScan } from "./scan-dsl";
