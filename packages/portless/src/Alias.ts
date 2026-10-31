import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as RpcProvider from "alchemy/Local/RpcProvider";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stage } from "alchemy/Stage";
import { moduleExtension } from "alchemy/Util/Node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Claims from "./internal/Claims.ts";
import * as Host from "./internal/Host.ts";
import { hostnameOf, originOf, routedName } from "./internal/Hostname.ts";
import { portOf } from "./internal/LoopbackUrl.ts";
import * as Mode from "./internal/Mode.ts";
import * as Routes from "./internal/Routes.ts";
import type { ProxyAttributes } from "./Proxy.ts";

export interface AliasProps {
  /** The proxy that routes to the listener. */
  proxy: ProxyAttributes;
  /**
   * The existing listener to route to. Only loopback addresses can be aliased:
   * `localhost`, `127.0.0.1` or `[::1]`. The proxy forwards plain HTTP to the
   * port, so the url must be `http://`.
   */
  url: string;
  /**
   * The service name in the hostname, in place of the resource id:
   * `<stage>.<name>.<domain>.localhost`.
   * @default the resource id
   */
  name?: string;
  /**
   * The exact hostname to register, in place of the stage-qualified one, for
   * callers that own their naming: `status.localhost`. `.localhost` is added
   * when missing.
   */
  hostname?: string;
}

export interface Alias extends Resource<
  "Portless.Alias",
  AliasProps,
  {
    /** The name the proxy serves the listener under, such as `dev-alice.floci.myapp.localhost`. */
    hostname: string;
    /**
     * Where to reach the listener through the proxy, such as
     * `https://dev-alice.floci.myapp.localhost`. With `PORTLESS=0` it is `url`.
     */
    origin: string;
  }
> {}

/**
 * A stable HTTPS name for a port that something else owns: an emulator, a
 * database admin page, a server another tool started. The listener keeps its
 * port; the proxy serves it under `<stage>.<id>.<domain>.localhost`.
 *
 * The route belongs to the dev sidecar, which outlives reloads of your stack
 * program, and goes when the resource is deleted or the sidecar stops. It
 * carries no process of its own, and nothing here stops the listener. A
 * hostname another resource already routes is rejected, not taken over. During
 * `alchemy deploy` the resource does nothing.
 *
 * ### Naming an existing listener
 * **Example:** Reach a local emulator by name
 * ```typescript
 * const floci = yield* Portless.Alias("Floci", {
 *   proxy,
 *   url: "http://localhost:4566",
 * });
 * floci.origin; // "https://dev-alice.floci.myapp.localhost"
 * ```
 *
 * ### Choosing the hostname
 * **Example:** An exact hostname
 * ```typescript
 * const status = yield* Portless.Alias("Status", {
 *   proxy,
 *   url: "http://127.0.0.1:9000",
 *   hostname: "status.localhost",
 * });
 * ```
 *
 * @resource
 */
export const Alias = Resource<Alias>("Portless.Alias");

export const AliasProvider = () =>
  ProviderLayer.dual(Alias, {
    live: AliasProviderLive,
    local: AliasProviderLocal,
  });

export const AliasProviderLive = () =>
  Provider.succeed(Alias, {
    list: () => Effect.succeed([]),
    diff: () => Effect.succeed({ action: "noop" }),
    reconcile: () => Effect.succeed({ hostname: "", origin: "" }),
    delete: () => Effect.void,
  });

export const AliasProviderLocal = () =>
  RpcProvider.effect(
    Alias,
    import.meta.resolve(`./Local${moduleExtension(import.meta.url)}`, import.meta.url),
    Effect.gen(function* () {
      const stage = yield* Stage;
      const fs = yield* FileSystem.FileSystem;
      const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

      // The routes this provider registered, by hostname. An alias has no process to
      // end with: its routes go when the provider does (the sidecar stopping), so the
      // proxy stops serving them at once instead of when it next reloads its routes.
      const routed = new Map<string, string>();
      const remove = (hostname: string, stateDirectory: string) =>
        Routes.removeRoute({ stateDirectory, hostname, ownerPid: Host.pid }).pipe(
          withFileSystem,
          Effect.ignore,
          Effect.andThen(Effect.sync(() => routed.delete(hostname))),
        );
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...routed],
          ([hostname, stateDirectory]) => remove(hostname, stateDirectory),
          {
            discard: true,
          },
        ),
      );

      const desired = Effect.fn(function* (
        id: string,
        props: {
          readonly proxy: ProxyAttributes;
          readonly url: string;
          readonly name?: string;
          readonly hostname?: string;
        },
      ) {
        const port = yield* portOf(props.url);
        const hostname = yield* hostnameOf(
          props.hostname ?? routedName(props.name ?? id, stage, props.proxy.domain),
        );
        const disabled = yield* Mode.disabled;
        return {
          hostname,
          port,
          origin: disabled ? props.url : originOf(hostname, props.proxy.port),
        };
      });

      return {
        // Reconcile whenever the sidecar doesn't route the name to the port: a new
        // sidecar (the previous dev session ended) has forgotten every alias.
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news)) return undefined;
          const { hostname, port } = yield* desired(id, news);
          if ((yield* Mode.disabled) || output === undefined) return undefined;
          const routes = yield* Routes.liveRoutes(news.proxy.stateDirectory).pipe(
            Effect.orElseSucceed(() => []),
          );
          const route = routes.find((candidate) => candidate.hostname === hostname);
          return route?.pid === Host.pid && route.port === port
            ? ({ action: "noop" } as const)
            : ({ action: "update" } as const);
        }),
        reconcile: Effect.fn(function* ({ id, fqn, instanceId, news, output }) {
          const { hostname, port, origin } = yield* desired(id, news);
          if (yield* Mode.disabled) return { hostname, origin };
          const { stateDirectory } = news.proxy;

          const held = yield* Claims.claim(hostname, { instanceId, fqn });
          yield* Routes.addRoute({ stateDirectory, hostname, port, ownerPid: Host.pid }).pipe(
            Effect.onError(() => held.release),
          );
          routed.set(hostname, stateDirectory);
          // An alias that moved to another name leaves the old route behind.
          if (output !== undefined && output.hostname !== hostname) {
            yield* Claims.release(output.hostname, instanceId);
            yield* remove(output.hostname, stateDirectory);
          }
          return { hostname, origin };
        }),
        delete: Effect.fn(function* ({ instanceId, olds, output }) {
          if (yield* Mode.disabled) return;
          yield* Claims.release(output.hostname, instanceId);
          yield* remove(output.hostname, olds.proxy.stateDirectory);
        }),
      };
    }),
  );
