/**
 * Shared scaffolding for local-simulator gateways.
 *
 * The local binding simulators (KV, R2, D1, ...) live inside workerd — only
 * a Worker with the native binding can reach them. Deploy-time code (Action
 * capability clients, provider reconciles) runs in Node, so these helpers
 * bridge the two: boot a scoped, ephemeral workerd instance whose only
 * module exposes the native binding over HTTP, hand the caller its URL, and
 * tear the instance down when the callback completes.
 *
 *   Node ── HTTP ──▶ gateway worker ──▶ native binding ──▶ simulator
 *
 * NOT exported from `index.ts` — provider/capability-internal scaffolding.
 */
import {
  layerRuntime,
  Runtime,
  type BindingHook,
  type BindingServices,
  type Module,
} from "@distilled.cloud/cloudflare-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { AlchemyContext } from "../AlchemyContext.ts";
import { CloudflareEnvironment } from "./CloudflareEnvironment.ts";

/**
 * A standalone local-runtime layer for gateway consumers OUTSIDE the
 * provider stack (e.g. capability `*Local` layers running in an Action,
 * whose ambient context has no workerd `Runtime`). Configured identically
 * to the providers' shared runtime — same `.alchemy/local` storage
 * directory — so it reads and writes the same simulator data.
 */
export const localGatewayRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const getEnv = yield* CloudflareEnvironment;
    const { dotAlchemy } = yield* AlchemyContext;
    const path = yield* Path.Path;
    return layerRuntime({
      api: {
        accountId: getEnv.pipe(Effect.map((env) => env.accountId)),
      },
      storage: {
        directory: path.join(dotAlchemy, "local"),
      },
    });
  }),
);

/**
 * Boot an ephemeral gateway workerd, hand `use` its URL, and tear the
 * instance down when `use` completes.
 */
export const withLocalGateway = <A, E, R>(
  options: {
    name: string;
    modules: Module[];
    bindings: BindingHook<BindingServices>[];
    unsafe?: Record<string, unknown>;
  },
  use: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* Runtime;
      const url = yield* runtime.start({
        name: options.name,
        compatibilityDate: "2025-01-01",
        compatibilityFlags: [],
        modules: options.modules,
        bindings: options.bindings as never,
        cache: false,
        ...(options.unsafe ? { unsafe: options.unsafe } : {}),
      });
      return yield* use(url);
    }),
  );

/** Sanitize an id into a workerd instance-name-safe suffix. */
export const gatewayName = (prefix: string, id: string) =>
  `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/**
 * An HttpClient that rewrites every request's origin to the gateway's,
 * keeping path and query intact — so distilled ops built for
 * `api.cloudflare.com` transparently hit the gateway's REST emulation.
 */
export const rebaseHttpClient = (
  client: HttpClient.HttpClient,
  gateway: URL,
): HttpClient.HttpClient =>
  HttpClient.mapRequest(
    HttpClientRequest.updateUrl((url) => {
      const rebased = new URL(url);
      rebased.protocol = gateway.protocol;
      rebased.host = gateway.host;
      return rebased.toString();
    }),
  )(client);
