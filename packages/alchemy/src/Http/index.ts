/**
 * alchemy/Http — routes as classes with pluggable implementations, on top
 * of Effect's `HttpApi`.
 *
 * - {@link get}, {@link post}, {@link put}, {@link patch}, {@link del}:
 *   route classes. A route is an `HttpApiEndpoint` that carries the tag of
 *   its implementation; `Route.make(init)` is one implementation as a Layer.
 * - {@link handlers}: mounts every route group of an `HttpApi` under that
 *   API's middleware, requiring the route tags.
 * - {@link Platform}: the platform services `HttpApiBuilder.layer` wants on
 *   Workers and Lambda.
 * - The server bridge every runtime shares: {@link HttpEffect},
 *   {@link serve}, {@link HttpServer}, and the Bun and Node servers.
 */
export {
  del,
  get,
  group,
  handlers,
  head,
  make,
  options,
  patch,
  post,
  put,
  RouteTag,
  type Handler,
  type Handlers,
  type Route,
  type RouteGroups,
  type RouteStatics,
  type Tags,
} from "./Route.ts";
export { Platform } from "./Platform.ts";
export * from "../Http.ts";
