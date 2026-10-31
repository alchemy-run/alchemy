import { IngressError, type IngressAdapter, type IngressFactory } from "alchemy/Local/Ingress";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Claims from "./Claims.ts";
import * as Host from "./Host.ts";
import { hostnameOf, originOf, routedName } from "./Hostname.ts";
import { portOf } from "./LoopbackUrl.ts";
import * as Mode from "./Mode.ts";
import * as Routes from "./Routes.ts";

/** What `Portless.Ingress(proxy)` puts in the config: where the proxy is and what it names things under. */
interface Settings {
  readonly domain: string;
  readonly port: number;
  readonly stateDirectory: string;
}

const fail = (error: { readonly message: string }) =>
  new IngressError({ type: "portless", message: error.message, cause: error });

const settingsOf = (options: Readonly<Record<string, unknown>> | undefined) =>
  Effect.suspend(() => {
    const { domain, port, stateDirectory } = options ?? {};
    return typeof domain === "string" &&
      typeof port === "number" &&
      typeof stateDirectory === "string"
      ? Effect.succeed<Settings>({ domain, port, stateDirectory })
      : Effect.fail(
          fail({
            message:
              "Portless.Ingress needs the proxy it routes through: pass the Portless.Proxy resource, as in Portless.Ingress(proxy).",
          }),
        );
  });

/** The hostname Portless.Origin gives the same id: `<stage>.<kebab label>.<domain>.localhost`. */
const hostnameFor = (
  settings: Settings,
  target: { readonly label: string; readonly stage: string },
) =>
  hostnameOf(routedName(target.label, target.stage, settings.domain)).pipe(Effect.mapError(fail));

/**
 * The Portless adapter for `alchemy dev`'s ingress contract. It runs in the
 * dev sidecar, so the routes it adds belong to the sidecar's process, which
 * outlives reloads of the stack program; closing the `Scope` removes the one
 * route an `attach` added. The proxy is the one the `Portless.Proxy` resource
 * started: this never starts, stops or reconfigures it.
 *
 * With `PORTLESS=0` there is no proxy: `attach` routes nothing and returns the
 * listener's own address.
 */
export const factory: IngressFactory = {
  make: (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const disabled = yield* Mode.disabled.pipe(Effect.mapError(fail));
      const settings = disabled ? undefined : yield* settingsOf(options);

      return {
        origin: Effect.fn(function* (target) {
          if (settings === undefined) {
            return yield* fail({
              message: `PORTLESS=0: ${target.label} has no Portless name. Its origin is the address it listens on, which is known once it does.`,
            });
          }
          return originOf(yield* hostnameFor(settings, target), settings.port);
        }),

        attach: Effect.fn(function* (target, listener) {
          if (settings === undefined) return listener.href;
          const hostname = yield* hostnameFor(settings, target);
          const port = yield* portOf(listener.href).pipe(Effect.mapError(fail));

          // One claim per resource: attaching the same resource again takes the route over, and
          // a resource of the same name routed elsewhere in this process is refused.
          const held = yield* Claims.claim(hostname, {
            instanceId: `ingress:${target.fqn}`,
            fqn: target.fqn,
          }).pipe(Effect.mapError(fail));
          // The same resource attached to the same listener again changes nothing.
          const routed = yield* Routes.liveRoutes(settings.stateDirectory).pipe(
            Effect.map((routes) =>
              routes.some(
                (route) =>
                  route.hostname === hostname && route.port === port && route.pid === Host.pid,
              ),
            ),
            Effect.orElseSucceed(() => false),
          );
          if (!routed) {
            yield* Routes.addRoute({
              stateDirectory: settings.stateDirectory,
              hostname,
              port,
              ownerPid: Host.pid,
            }).pipe(
              Effect.mapError(fail),
              Effect.onError(() => held.release),
            );
          }
          // Gives up the route this call added, unless a later attach for the same resource took
          // it over: that one's claim replaced this one's.
          yield* Effect.addFinalizer(() =>
            held.release.pipe(
              Effect.flatMap((mine) =>
                mine
                  ? Routes.removeRoute({
                      stateDirectory: settings.stateDirectory,
                      hostname,
                      ownerPid: Host.pid,
                    }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.ignore)
                  : Effect.void,
              ),
            ),
          );
          return originOf(hostname, settings.port);
        }),
      } satisfies IngressAdapter;
    }),
};
