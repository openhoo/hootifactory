import type { RegistryErrorCode, ZodType } from "@hootifactory/core";
import type {
  HttpMethod,
  Permission,
  RegistryRequestContext,
  RouteEntry,
  RouteMatch,
} from "./adapter";

export type MaybePromise<T> = T | Promise<T>;

type RegistryRouteParamName<Segment extends string> = Segment extends `:${infer Param}`
  ? Param extends `${infer Name}+`
    ? Name
    : Param
  : never;

type RegistryRouteParamNames<Pattern extends string> =
  Pattern extends `${infer Segment}/${infer Rest}`
    ? RegistryRouteParamName<Segment> | RegistryRouteParamNames<Rest>
    : RegistryRouteParamName<Pattern>;

export type RegistryRouteParams<Pattern extends string> = string extends Pattern
  ? Record<string, string>
  : Record<RegistryRouteParamNames<Pattern>, string>;

export interface RegistryRouteInput<
  Params extends Record<string, string> = Record<string, string>,
> {
  match: RouteMatch;
  params: Params;
  req: Request;
  ctx: RegistryRequestContext;
}

export interface RegistryPermissionInput<
  Params extends Record<string, string> = Record<string, string>,
> {
  method: HttpMethod;
  match: RouteMatch;
  params: Params;
  ctx: RegistryRequestContext;
}

export type RegistryRouteHandler<Params extends Record<string, string> = Record<string, string>> = (
  input: RegistryRouteInput<Params>,
) => MaybePromise<Response>;

export type RegistryPermissionResolver<
  Params extends Record<string, string> = Record<string, string>,
> = Permission | ((input: RegistryPermissionInput<Params>) => Permission);

export type RegistryBeforeHandleHook<
  Params extends Record<string, string> = Record<string, string>,
> = (input: RegistryRouteInput<Params>) => MaybePromise<void>;

/**
 * Error overrides applied when a route param fails its schema. Defaults match
 * `parseRegistryInput`: status 400, code "UNSUPPORTED", message "invalid
 * request", detail = the zod issue tree.
 */
export interface RegistryRouteParamErrorOptions {
  code?: RegistryErrorCode;
  message?: string;
  status?: number;
}

/**
 * A route-param schema accepts the raw string path segment and must output a
 * string (transforms may normalize, e.g. lowercase). The schema OUTPUT is what
 * permission resolvers and handlers observe in `params`; the static `Params`
 * type intentionally stays `string`-typed (validated-but-string-typed) rather
 * than threading per-schema output types through `RegistryRouteParams`.
 */
export type RegistryRouteParamSchema = ZodType<string, string>;

/** A param schema plus per-param error overrides. */
export interface RegistryRouteParamSpec extends RegistryRouteParamErrorOptions {
  schema: RegistryRouteParamSchema;
}

export type RegistryRouteParamInput = RegistryRouteParamSchema | RegistryRouteParamSpec;

/** Compatibility alias for the first simple schema-only route-param API. */
export type RegistryRouteParamSchemas<
  Params extends Record<string, string> = Record<string, string>,
> = {
  readonly [K in keyof Params]?: RegistryRouteParamSchema;
};

/** Map of route-param name -> schema (or schema + error overrides). */
export type RegistryRouteParamsShape<
  Params extends Record<string, string> = Record<string, string>,
> = {
  readonly [K in keyof Params]?: RegistryRouteParamInput;
};

export interface RegistryRouteSpec<Params extends Record<string, string> = Record<string, string>>
  extends RouteEntry {
  /** Compatibility alias; prefer `params` for per-param error overrides. */
  paramSchemas?: RegistryRouteParamSchemas<Params>;
  permission?: RegistryPermissionResolver<Params>;
  /**
   * Per-param schemas validated BEFORE permission resolution and BEFORE the
   * handler. A failing param short-circuits the request to the parse error
   * (the same `RegistryError` `parseRegistryInput` raises), and the permission
   * resolver and handler both observe the validated/normalized outputs.
   */
  params?: RegistryRouteParamsShape<Params>;
  handler: RegistryRouteHandler<Params>;
}

export type AnyRegistryRouteSpec = RegistryRouteSpec<any>;

export type RegistryRouteOptions<Params extends Record<string, string> = Record<string, string>> =
  Omit<RegistryRouteSpec<Params>, "method" | "pattern" | "handlerId" | "handler">;

export interface RegistryRouteFactory {
  <Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryRouteHandler<RegistryRouteParams<Pattern>>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): RegistryRouteSpec<RegistryRouteParams<Pattern>>;
  <Params extends Record<string, string> = Record<string, string>>(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<Params>,
    options?: RegistryRouteOptions<Params>,
  ): RegistryRouteSpec<Params>;
}

export type RegistryRoutePrefixFactory = (
  prefix: string,
  routes: RegistryRouteList,
) => RegistryRouteSpec<any>[];

export interface RegistryRouteDsl {
  get: RegistryRouteFactory;
  head: RegistryRouteFactory;
  put: RegistryRouteFactory;
  post: RegistryRouteFactory;
  patch: RegistryRouteFactory;
  delete: RegistryRouteFactory;
  prefix: RegistryRoutePrefixFactory;
  searchGet: RegistryRouteFactory;
  searchPost: RegistryRouteFactory;
  serviceIndex: RegistryRouteFactory;
  metadataGet: RegistryRouteFactory;
  immutableGet: RegistryRouteFactory;
}

export type RegistryRouteList =
  | readonly AnyRegistryRouteSpec[]
  | ((route: RegistryRouteDsl) => readonly AnyRegistryRouteSpec[]);
