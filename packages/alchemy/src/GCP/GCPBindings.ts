import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Input } from "../Input.ts";
import { externalGcpAccess, externalHost, externalServices } from "./ExternalHost.ts";
import type { GcpIamGrant } from "./Host.ts";
import { isNativeHost } from "./NativeHost.ts";

/**
 * How a GCP binding reaches its host's GCP identity. Native hosts (Cloud Run,
 * Cloud Functions, Kubernetes on GKE) run as a service account: bindings
 * grant on it and sign with its metadata-server token. Any other host (a
 * Cloudflare Worker, an AWS Lambda, …) is external: Alchemy mints a service
 * account and a key for it, bindings grant on that account, and calls sign
 * with tokens minted from the key.
 */

/**
 * Resolve a distilled operation with the host's GCP credentials, once at
 * layer init: as-is on a native host (and for the deployer, with no host),
 * provided with the minted account's credentials on an external host.
 *
 * Bundles built for a native GCP host fold `__ALCHEMY_NATIVE_HOST__` to
 * `"GCP"`, so the external path drops out of them.
 */
export const withCredentials = <Op>(operation: Effect.Effect<Op, never, any>): Effect.Effect<Op> =>
  globalThis.__ALCHEMY_NATIVE_HOST__ === "GCP"
    ? (operation as Effect.Effect<Op>)
    : Effect.gen(function* () {
        const host = yield* Binding.Host;
        if (host === undefined || isNativeHost(host)) {
          return yield* operation as Effect.Effect<Op>;
        }
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- only reached with a host, whose init provides RuntimeContext
        const access = yield* externalGcpAccess(host) as Effect.Effect<
          Effect.Success<ReturnType<typeof externalGcpAccess>>
        >;
        return yield* (operation as Effect.Effect<Op>).pipe(
          Effect.provide(externalServices(access)),
        );
      });

/** What a GCP binding attaches to its host. */
export interface HostBinding {
  /** The IAM roles the binding needs, granted to the host's identity. */
  readonly iam?: Input<GcpIamGrant>[];
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
  /**
   * Cloud SQL connection names (`project:region:instance`) to mount as Unix
   * sockets under `/cloudsql` (Cloud Run services only).
   */
  readonly cloudSqlInstances?: Input<string>[];
}

/**
 * Attach a binding to its host, labelled `Allow(<host>, <label>)`: the IAM
 * grants go to the native host's runtime identity, or to the external host's
 * minted service account. Call it behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` so the bundler drops it.
 *
 * ```ts
 * if (!globalThis.__ALCHEMY_RUNTIME__) {
 *   yield* GCPBindings.bind`GCP.PubSub.WriteTopic(${topic})`({
 *     iam: [{ role: "roles/pubsub.publisher", resource: { kind: "pubsub.topic", name: topic.name } }],
 *   });
 * }
 * ```
 */
export const bind =
  (label: TemplateStringsArray, ...args: unknown[]) =>
  (data: HostBinding): Effect.Effect<void> =>
    Effect.gen(function* () {
      const host = yield* Binding.Host;
      if (host === undefined) return;
      const target = isNativeHost(host)
        ? host
        : // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- only reached with a host, whose init provides RuntimeContext
          externalHost(host, yield* externalGcpAccess(host) as Effect.Effect<any>);
      const strings = ["Allow(", `, ${label[0]}`, ...label.slice(1)];
      strings[strings.length - 1] += ")";
      const template = Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;
      yield* (
        target.bind as unknown as (...args: unknown[]) => (data: HostBinding) => Effect.Effect<void>
      )(
        template,
        target,
        ...args,
      )(data);
    });

/**
 * Fail a binding at deploy time on an external host, for bindings that need
 * the GCP runtime itself (e.g. the metadata server's ID tokens).
 */
export const requireNativeHost = (tag: string) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const host = yield* Binding.Host;
    if (host === undefined || isNativeHost(host)) return;
    return yield* Effect.die(
      new Error(
        `${tag} needs a GCP host (Cloud Run, Cloud Functions or GKE): it reads the metadata server, which ${host.Type} ${host.LogicalId} doesn't have.`,
      ),
    );
  });
