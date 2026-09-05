import { loadInternalWorker } from "../internal/internal-worker.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
const ClientWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/remote-bindings/workers/client.worker",
    ),
};
const OutboundWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/remote-bindings/workers/outbound.worker",
    ),
};
import * as Loopback from "../globals/Loopback.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "../internal/constants.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import * as PluginContext from "../PluginContext.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as RemoteWorker from "./RemoteWorker.ts";
import type {
  RemoteBinding,
  RemoteWorkerConfig,
} from "./RemoteWorkerConfig.shared.ts";

export class RemoteBindings extends Plugin.Service<
  RemoteBindings,
  {
    readonly register: (
      binding: RemoteBinding,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/RemoteBindings") {}

export type { RemoteBinding };

/**
 * One worker's registration: the binding as the proxy will carry it, plus the
 * name the user actually wrote. The original is diagnostics only — see the
 * aliasing warning in `build`.
 */
interface Registered {
  readonly proxy: RemoteBinding;
  readonly original: string;
}

/**
 * The proxy script name. A constant, deliberately.
 *
 * Deriving it from the first worker to build is a race — workers build
 * concurrently — and `cloudflare-vite-plugin` names an unnamed worker
 * `vite-dev-${randomUUID()}`, which would rename the proxy (and its preview
 * host) on every restart. A per-worker name buys no isolation anyway: see below.
 */
const PROXY_SCRIPT_NAME = "alchemy-remote-bindings";

export const RemoteBindingsLive = Layer.effect(
  RemoteBindings,
  Effect.gen(function* () {
    const loopback = yield* Loopback.Loopback;
    const remoteWorker = yield* RemoteWorker.RemoteWorker;

    /**
     * Every worker's remote bindings live on **one** proxy script.
     *
     * This used to be one proxy per worker, each with its own name, its own
     * preview session and its own binding set — which reads as clean isolation
     * and is not. Cloudflare's edge preview is scoped to the **account
     * subdomain**, not to the script: deploy several previews concurrently and
     * they collapse onto a single live script. Every proxy URL, presented with
     * its own preview token, then serves whichever upload survived.
     *
     * So a worker asking for a binding the survivor does not carry gets
     * `BindingNotFound` — from a proxy whose own upload metadata listed exactly
     * that binding. Measured directly: three previews (two uploaded with
     * `VECTORS`, one with `Vectors`, on two hostnames) all answered as the
     * `Vectors` script.
     *
     * Keyed by **worker**, not by binding name. `LocalWorkerProvider` restarts a
     * worker whenever its binding hash changes, so `build` re-runs throughout a
     * dev session; keying by worker makes a restart *replace* that worker's
     * entry. Keyed by binding name it would instead accumulate dead bindings for
     * the life of the process — and a repointed resource would "conflict" with
     * the worker's own previous incarnation.
     *
     * The key is stable under `alchemy dev`, where `LocalWorkerProvider` passes
     * a deterministic `worker.name` through every restart. It is **not** stable
     * for a standalone `cloudflare-vite-plugin` run that leaves the worker
     * unnamed: that path mints `vite-dev-${randomUUID()}` per restart, so old
     * entries accumulate under dead keys. Harmless for correctness — namespaced
     * names cannot collide — but it is why the delete below matters.
     */
    const byWorker = new Map<string, ReadonlyArray<Registered>>();
    const warnedAliases = new Set<string>();

    /**
     * The proxy-side binding name, namespaced per worker.
     *
     * That name is a free variable: `register` chooses the string, the client
     * worker sends it as `MF-Binding`, and the proxy does `env[thatString]`.
     * Nothing requires it to equal the name the user bound. Namespacing it means
     * two workers can bind **different** resources under the **same** name —
     * ordinary in a multi-worker stack — and share one script with no
     * cross-wiring, so a collision is not something this has to reject.
     */
    const workerKey = (name: string): string => {
      let hash = 5381;
      for (let i = 0; i < name.length; i++) {
        hash = ((hash * 33) ^ name.charCodeAt(i)) >>> 0;
      }
      return `w${hash.toString(36)}`;
    };
    const proxyBindingName = (
      workerName: string,
      bindingName: string,
    ): string => `${workerKey(workerName)}_${bindingName}`;

    /** A binding's identity ignoring what it is called. */
    const shapeOf = (binding: RemoteBinding): string => {
      const { name: _name, ...rest } = binding as RemoteBinding & {
        name: string;
      };
      return JSON.stringify(rest);
    };

    if (Effect.isEffect(loopback)) {
      return yield* Effect.die("Expected loopback to be initialized");
    }
    const serviceDesignator = yield* loopback.api.route(
      "remote-bindings",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Drained but vestigial: the caller posts its own worker's config, and
        // what gets deployed is the union of every worker's. Left in the
        // protocol so the outbound Durable Object needs no change.
        yield* request.json;
        const config: RemoteWorkerConfig = {
          name: PROXY_SCRIPT_NAME,
          bindings: [...byWorker.values()].flatMap((entries) =>
            entries.map((entry) => entry.proxy),
          ),
        };
        // Deployed fresh on every call, which is what keeps the outbound DO's
        // session refresh and stale-session recovery working — both rely on
        // getting a new preview token back.
        return yield* remoteWorker.deploy(config).pipe(
          Effect.flatMap((result) =>
            HttpServerResponse.json({ ok: true, result }),
          ),
          Effect.tapCause((cause) => Effect.logError(Cause.pretty(cause))),
          Effect.catch((error) =>
            HttpServerResponse.json({ ok: false, error }, { status: 500 }),
          ),
        );
      }),
    );
    const build = Effect.fn(function* (
      workerName: string,
      entries: ReadonlyArray<Registered>,
    ): Effect.fn.Return<Plugin.PluginConfig> {
      if (entries.length === 0) {
        // Deleting, not just returning: a worker that restarts having lost its
        // last remote binding must stop contributing to the union. Returning
        // early would leave the previous incarnation's entries in place for the
        // life of the process, so the proxy would keep uploading a binding the
        // user deleted — and since the union uploads as a single metadata blob,
        // one binding whose resource is gone fails the upload for every worker.
        // Upstream could not have this problem: it held no state at all.
        byWorker.delete(workerName);
        return {};
      }
      byWorker.set(workerName, entries);

      // One resource, two names. Legal, and harmless once unioned — but it is
      // the condition that kept the collapse above hidden: while the names
      // agreed, landing on another worker's proxy still found the binding.
      // Warned once per pair, because `build` re-runs on every worker restart
      // and a warning that repeats on every edit is one people scroll past.
      const seen = new Map<string, { original: string; workerName: string }>();
      for (const [owner, registered] of byWorker) {
        for (const entry of registered) {
          const shape = shapeOf(entry.proxy);
          const prior = seen.get(shape);
          if (prior === undefined) {
            seen.set(shape, { original: entry.original, workerName: owner });
            continue;
          }
          if (prior.original === entry.original) continue;
          const pair =
            [prior.original, entry.original].sort().join("\u0000") + shape;
          if (warnedAliases.has(pair)) continue;
          warnedAliases.add(pair);
          yield* Effect.logWarning(
            `Remote binding declared under two different names for the same resource: ` +
              `"${prior.original}" in ${prior.workerName} and "${entry.original}" in ${owner}. ` +
              `Both work, but naming it identically in every worker is less confusing.`,
          );
        }
      }

      // Deliberately no prefetch. The union is not complete until every worker
      // has built, so warming it here would upload a partial set — and racing
      // concurrent uploads is the very thing that broke this. The outbound
      // Durable Object calls the loopback lazily, on first use of a binding, and
      // a worker's own bindings are always registered before its outbound DO
      // exists (the DO comes from the config this function returns), so no
      // worker can ever deploy a union that is missing itself.
      const [outboundWorker, clientWorker] = yield* Effect.forEach(
        [OutboundWorker, ClientWorker],
        (worker) =>
          Effect.map(
            Effect.promise(worker.worker),
            formatInternalWorkerModules,
          ),
        { concurrency: "unbounded" },
      );
      const outbound = {
        name: "remote-bindings:outbound",
        worker: {
          compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
          modules: outboundWorker,
          bindings: [
            {
              name: "PROXY",
              durableObjectNamespace: { className: "RemoteBindingProxy" },
            },
            {
              name: "LOOPBACK",
              service: serviceDesignator,
            },
            {
              name: "OPTIONS",
              json: JSON.stringify({
                name: workerName,
                bindings: entries.map((entry) => entry.proxy),
              } satisfies RemoteWorkerConfig),
            },
          ],
          durableObjectNamespaces: [
            {
              className: "RemoteBindingProxy",
              enableSql: true,
              preventEviction: true,
              ephemeralLocal: WorkerdConfig.kVoid,
            },
          ],
        },
      } satisfies WorkerdConfig.Service;
      const client = {
        name: "remote-bindings:client",
        worker: {
          compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
          modules: clientWorker,
          globalOutbound: { name: outbound.name },
        },
      } satisfies WorkerdConfig.Service;
      return {
        services: [client, outbound],
      };
    });
    return RemoteBindings.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext.PluginContext;
        const entries: Array<Registered> = [];
        return {
          defer: Effect.suspend(() => build(worker.name, entries)),
          api: {
            register: (binding) =>
              Effect.sync(() => {
                const name = proxyBindingName(worker.name, binding.name);
                entries.push({
                  proxy: { ...binding, name },
                  original: binding.name,
                });
                return {
                  name: "remote-bindings:client",
                  props: {
                    json: JSON.stringify({ binding: name }),
                  },
                };
              }),
          },
        };
      }),
    );
  }),
);

export const makeRemoteBinding = (
  binding: RemoteBinding,
  f: (service: WorkerdConfig.ServiceDesignator) => WorkerdConfig.Worker_Binding,
): PluginContext.BindingHook<RemoteBindings> =>
  Effect.map(
    Plugin.use(RemoteBindings, (remoteBindings) =>
      remoteBindings.api.register(binding),
    ),
    f,
  );
