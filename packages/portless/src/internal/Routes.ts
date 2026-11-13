import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { RouteConflictError, RouteStore, type RouteMapping } from "portless";
import { HostnameClaimed, RouteStoreFailed } from "../Errors.ts";

/**
 * Portless's route store as Effects. A route belongs to a process: Portless
 * serves it while that process lives and drops it once the process is gone.
 */

const failed = (
  operation: RouteStoreFailed["operation"],
  stateDirectory: string,
  hostname: string | undefined,
  cause: unknown,
) => new RouteStoreFailed({ operation, stateDirectory, hostname, cause });

/** Registers a route for a process. Fails while another live process owns the hostname. */
export const addRoute = (route: {
  readonly stateDirectory: string;
  readonly hostname: string;
  readonly port: number;
  readonly ownerPid: number;
}) =>
  Effect.try({
    try: () => {
      new RouteStore(route.stateDirectory).addRoute(route.hostname, route.port, route.ownerPid);
    },
    catch: (cause) =>
      cause instanceof RouteConflictError
        ? new HostnameClaimed({
            hostname: route.hostname,
            fqn: undefined,
            pid: cause.existingPid,
          })
        : failed("add", route.stateDirectory, route.hostname, cause),
  });

/** Records the process group a route's command runs in, so Portless can find it again. */
export const updateRoute = (input: {
  readonly stateDirectory: string;
  readonly hostname: string;
  readonly childPgid: number;
  readonly childStartTime: string | undefined;
}) =>
  Effect.try({
    try: () =>
      new RouteStore(input.stateDirectory).updateRoute(input.hostname, {
        childPgid: input.childPgid,
        childStartTime: input.childStartTime ?? null,
      }),
    catch: (cause) => failed("update", input.stateDirectory, input.hostname, cause),
  });

/**
 * Removes a route while its owner is still the given process. A state
 * directory that no longer exists holds no route to remove.
 */
export const removeRoute = Effect.fn(function* (route: {
  readonly stateDirectory: string;
  readonly hostname: string;
  readonly ownerPid: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(route.stateDirectory)
    .pipe(
      Effect.mapError((cause) => failed("remove", route.stateDirectory, route.hostname, cause)),
    );
  if (!exists) return;
  yield* Effect.try({
    try: () => new RouteStore(route.stateDirectory).removeRoute(route.hostname, route.ownerPid),
    catch: (cause) => failed("remove", route.stateDirectory, route.hostname, cause),
  });
});

/** The routes whose owners are alive. */
export const liveRoutes = (
  stateDirectory: string,
): Effect.Effect<RouteMapping[], RouteStoreFailed> =>
  Effect.try({
    try: () => new RouteStore(stateDirectory).loadRoutes(),
    catch: (cause) => failed("load", stateDirectory, undefined, cause),
  });
