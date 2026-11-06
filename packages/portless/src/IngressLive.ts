/**
 * The Portless router for `alchemy dev`'s ingress. `Portless.Ingress(proxy)`
 * names this module, and the dev sidecar imports it and builds its default
 * export once. User code and Worker bundles never import it.
 *
 * The routes it adds belong to the sidecar's process, which outlives reloads
 * of the stack program; closing the `Scope` of an `attach` removes the one
 * route it added. The proxy is the one the `Portless.Proxy` resource started:
 * this never starts, stops or reconfigures it.
 *
 * With `PORTLESS=0` there is no proxy: `attach` routes nothing and returns the
 * listener's own address.
 *
 * @module
 */
import * as Ingress from "alchemy/Local/Ingress";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Claims from "./internal/Claims.ts";
import * as Host from "./internal/Host.ts";
import { hostnameOf, originOf, routedName } from "./internal/Hostname.ts";
import { portOf } from "./internal/LoopbackUrl.ts";
import * as Mode from "./internal/Mode.ts";
import * as Routes from "./internal/Routes.ts";

/** What `Portless.Ingress(proxy)` puts in the value: the route's name and the proxy it goes through. */
const Settings = Schema.Struct({
  name: Schema.optional(Schema.String),
  domain: Schema.String,
  tld: Schema.String,
  port: Schema.Number,
  stateDirectory: Schema.String,
});

const fail = (error: { readonly message: string }) =>
  new Ingress.IngressError({ message: error.message, cause: error });

export default Layer.effect(
  Ingress.Router,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      attach: Effect.fn("Portless.Ingress.attach")(function* (ingress, target, listener) {
        // Read on every attach, not once: the router lives as long as the sidecar.
        if (yield* Mode.disabled.pipe(Effect.mapError(fail))) return listener.href;
        const settings = yield* Schema.decodeUnknownEffect(Settings)(ingress).pipe(
          Effect.mapError(() =>
            fail({
              message:
                "Portless.Ingress needs the proxy it routes through: pass the Portless.Proxy resource, as in Portless.Ingress(proxy).",
            }),
          ),
        );
        // The hostname Portless.Origin gives the same id: `<stage>.<kebab label>.<domain>.<tld>`.
        const label = settings.name ?? target.id;
        const hostname = yield* hostnameOf(
          routedName(label, target.stage, settings.domain),
          settings.tld,
        ).pipe(Effect.mapError(fail));
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
    };
  }),
);
