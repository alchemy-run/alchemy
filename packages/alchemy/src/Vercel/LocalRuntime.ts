/**
 * Shared state for Vercel's local (dev-mode) providers.
 *
 * Mirrors `Cloudflare/LocalRuntime.ts`: a module-memoized layer reference
 * composed into each local provider's `ProviderLayer.dual` thunk, plus the
 * sidecar entry URL every Vercel local provider registers under (one
 * sidecar process serves all Vercel local providers, so they share this
 * state — see `src/Vercel/Local.ts`).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as RpcProvider from "../Local/RpcProvider.ts";
import type { QueueTriggerEntry } from "./Deploy/BuildOutput.ts";
import { LocalEdgeConfigStateLive } from "./EdgeConfig/LocalEdgeConfigState.ts";
import { LocalQueueBrokerLive } from "./Queues/LocalQueueBroker.ts";

export const LOCAL_ENTRY_URL = import.meta.resolve(
  // `import.meta.url` reflects the on-disk extension of *this* file (`.ts`
  // when loaded from `src/` under bun, `.js` from the compiled `lib/`),
  // which is exactly the signal we need to resolve the sibling entry.
  import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
  import.meta.url,
);

/**
 * A locally running Vercel Function instance, registered by the
 * `LocalFunctionProvider` once its dev server is serving and removed on
 * delete.
 *
 * **This registry is the seam for local queue delivery**: the sidecar's
 * `LocalQueueBroker` (see `Queues/LocalQueueBroker.ts`) delivers a topic's
 * messages by finding every registered instance whose {@link queues}
 * triggers match the topic and POSTing the platform's CloudEvent delivery
 * format to {@link queueEndpoint} (the running dev shim proxies that route
 * to the function's queue-mode bridge, which dispatches to the
 * init-registered `subscribe` handlers). Cron emulation runs inside the
 * function provider itself and needs nothing from here.
 */
export interface LocalFunctionInstance {
  /** Logical resource id of the Function. */
  readonly functionId: string;
  /** Stable local URL (`http://localhost:<port>`, the dev proxy). */
  readonly url: string;
  /**
   * The instance's dev deployment id (`dev:dpl_<confighash>`) — the value
   * its child process sees as `VERCEL_DEPLOYMENT_ID`. The local queue
   * broker uses it for per-deployment partition emulation.
   */
  readonly deploymentId: string;
  /** Queue triggers contributed by `subscribe` bindings. */
  readonly queues: ReadonlyArray<QueueTriggerEntry>;
  /**
   * POST CloudEvent queue deliveries here. `undefined` when the Function
   * registered no queue subscriptions (the shim then serves no queue
   * route).
   */
  readonly queueEndpoint: string | undefined;
  /**
   * The local `CRON_SECRET` value (present only while crons are
   * registered). Deliveries to cron routes must send
   * `Authorization: Bearer <cronSecret>`.
   */
  readonly cronSecret: string | undefined;
}

/**
 * Registry of locally running Vercel Functions, keyed by logical id.
 * Lives in the dev sidecar (or the test process when `sidecar: false`),
 * shared by every Vercel local provider built from
 * {@link localVercelServices}.
 */
export class LocalFunctionState extends Context.Service<
  LocalFunctionState,
  {
    readonly functions: MutableHashMap.MutableHashMap<
      string,
      LocalFunctionInstance
    >;
  }
>()("alchemy/vercel/LocalFunctionState") {}

const LocalFunctionStateLive = Layer.succeed(
  LocalFunctionState,
  LocalFunctionState.of({ functions: MutableHashMap.empty() }),
);

const makeLocalVercelServices = () =>
  RpcProvider.providerServicesEffect(
    Effect.succeed(
      Layer.mergeAll(
        LocalFunctionStateLive,
        // The dev queue broker shares the SAME LocalFunctionState instance:
        // the build MemoMap dedupes the repeated layer reference.
        LocalQueueBrokerLive.pipe(Layer.provide(LocalFunctionStateLive)),
        LocalEdgeConfigStateLive,
      ),
    ),
  );

let _localVercelServices:
  | ReturnType<typeof makeLocalVercelServices>
  | undefined;

/**
 * The shared local-runtime dependency layer for Vercel local providers.
 *
 * Returns a **module-memoized layer reference**: local providers register
 * via `ProviderLayer.dual`, which builds each provider's local variant
 * lazily against the stack build's shared `Layer.MemoMap` — memoization is
 * keyed by layer identity, so every Vercel local provider composing this
 * exact reference shares one {@link LocalFunctionState} per stack build.
 * Empty when an `RpcProviderProxy` is in context (the state then lives in
 * the sidecar).
 */
export const localVercelServices = () =>
  (_localVercelServices ??= makeLocalVercelServices());
