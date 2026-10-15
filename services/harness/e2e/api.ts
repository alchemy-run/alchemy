import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { HarnessRpcs } from "../src/HarnessRpcs.ts";

export const API_URL = process.env.API_URL ?? "http://localhost:1338";

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof HarnessRpcs>, RpcClientError.RpcClientError>;

/** The harness's API (`HarnessRpcs`), as the web UI calls it. */
export class Api extends Context.Service<Api, Client>()("harness/e2e/Api") {}

const runtime = ManagedRuntime.make(
  Layer.effect(Api, HarnessRpcs.pipe(RpcClient.make)).pipe(
    Layer.provide(RpcClient.layerProtocolHttp({ url: API_URL })),
    Layer.provide(Layer.mergeAll(RpcSerialization.layerNdjson, FetchHttpClient.layer)),
  ),
);

/** Run an effect against the API. */
export const run = <A, E>(effect: Effect.Effect<A, E, Api>) => runtime.runPromise(effect);

/** Start the session (idempotent) and run one turn to its result. */
export const turn = Effect.fn(function* (sessionId: string, prompt: string) {
  const api = yield* Api;
  yield* api.start({ sessionId });
  const { turnId } = yield* api.prompt({ sessionId, prompt });
  return yield* api.result({ sessionId, turnId });
});

/** The session as the server lists it. */
export const listed = Effect.fn(function* (sessionId: string) {
  const sessions = yield* Api.use((api) => api.list());
  return sessions.find((session) => session.id === sessionId);
});

/** A turn's reply text. */
export const text = (result: Effect.Success<ReturnType<typeof turn>>) =>
  result.message.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
