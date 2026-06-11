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

export interface RegistryRouteSpec<Params extends Record<string, string> = Record<string, string>>
  extends RouteEntry {
  permission?: RegistryPermissionResolver<Params>;
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
