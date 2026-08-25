/**
 * The Rivet **gateway client**: the runtime transport both sides of a Rivet
 * deployment use to reach an actor (a hosted `Alchemy.DurableObject`)
 * through the Rivet Engine's guard service.
 *
 * One protocol, verified against the engine
 * (`rivetdev/engine`, rivetkit 2.3.10):
 *
 * ```
 * POST {endpoint}/gateway/{actorName}/action/{method}
 *   ?rvt-namespace={namespace}   // engine namespace, "default"
 *   &rvt-method=getOrCreate
 *   &rvt-key={instanceName}      // the Durable Object instance name
 *   &rvt-runner={pool}           // the runner pool serving the actor
 *   &rvt-token={token}
 * body     {"args": [...]}
 * response {"output": ...}
 * ```
 *
 * Typed `Effect.fail`s cross the wire as alchemy's RPC error envelope in
 * `output` (the actor bridge RETURNS them — Rivet's own action-error path
 * erases payloads) and are lifted back into the error channel here via
 * {@link decodeRpcResult}. `Stream` results arrive as collected arrays (see
 * `ActorBridge.ts`).
 *
 * Consumed by `Rivet.Worker`'s `remoteDurableObject` (callers outside the
 * runner) and by the generated runner entry's synthetic worker environment
 * (in-runner `getByName`, which round-trips through the engine so instances
 * resolve to whichever runner owns them).
 *
 * @internal runtime-bundled; dependency-light by design.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { decodeRpcResult } from "../Rpc.ts";

/** A named Durable Object (actor) namespace client. */
export interface DurableObjectNamespaceClient {
  getByName: (name: string) => any;
}

/** The engine namespace actors are created in. */
export const RIVET_ACTOR_NAMESPACE = "default";
/** The runner pool the engine routes `getOrCreate` requests to. */
export const RIVET_RUNNER_POOL = "default";

/** A non-2xx answer from the Rivet Engine's gateway. */
export class RivetGatewayError extends Data.TaggedError("RivetGatewayError")<{
  readonly status: number;
  /** The engine's error code (e.g. `action_not_found`), when parseable. */
  readonly code?: string;
  readonly body?: string;
}> {
  override get message() {
    return `Rivet gateway returned ${this.status}${
      this.code !== undefined ? ` (${this.code})` : ""
    }${this.body ? `: ${this.body.slice(0, 256)}` : ""}`;
  }
}

export interface RivetGatewayConnection {
  /** The engine guard endpoint WITHOUT auth, e.g. `http://engine.internal:6420`. */
  readonly endpoint: string;
  /** The token checked by the engine (`rvt-token`). */
  readonly token: string;
  /**
   * The engine namespace (`rvt-namespace`).
   * @default RIVET_ACTOR_NAMESPACE
   */
  readonly namespace?: string;
  /**
   * The runner pool (`rvt-runner`).
   * @default RIVET_RUNNER_POOL
   */
  readonly pool?: string;
}

/**
 * Parse a `RIVET_ENDPOINT` value in rivetkit's URL-auth form
 * (`http://{namespace}:{token}@host:port`) into a gateway connection.
 * A plain endpoint (no auth) yields an empty token and the default
 * namespace.
 */
export const parseRivetEndpoint = (raw: string): RivetGatewayConnection => {
  const url = new URL(raw);
  const namespace = url.username
    ? decodeURIComponent(url.username)
    : RIVET_ACTOR_NAMESPACE;
  const token = url.password ? decodeURIComponent(url.password) : "";
  return { endpoint: url.origin, token, namespace };
};

/** Compose a `RIVET_ENDPOINT` value in rivetkit's URL-auth form. */
export const formatRivetEndpoint = (options: {
  readonly endpoint: string;
  readonly namespace: string;
  readonly token: string;
}): string => {
  const url = new URL(options.endpoint);
  url.username = options.namespace;
  url.password = options.token;
  return url.toString();
};

const transientStatus = (status: number): boolean =>
  status === 429 || status === 502 || status === 503 || status === 504;

/**
 * Satisfy the call's `HttpClient` requirement: the ambient client when the
 * surrounding runtime provides one (Lambda, workers), a fetch-backed client
 * otherwise (bare runner processes).
 */
const withHttpClient = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Effect.Effect<A, E> =>
  Effect.serviceOption(HttpClient.HttpClient).pipe(
    Effect.flatMap((ambient): Effect.Effect<A, E> =>
      Option.isSome(ambient)
        ? Effect.provideService(effect, HttpClient.HttpClient, ambient.value)
        : Effect.provide(effect, FetchHttpClient.layer),
    ),
  );

// Effect's internal Stream brand — see `asEffectOrStream` in Rpc.ts for the
// dual-form trick this replicates.
const StreamTypeId = "~effect/Stream";

/**
 * The Rivet flavor of `asEffectOrStream`: the call is BOTH an `Effect`
 * (value methods) and a `Stream` (streaming methods). The actor bridge
 * COLLECTS server-side streams to arrays (Rivet actions cannot stream), so
 * the stream form re-expands an array result into its elements — a caller
 * piping `Stream.runCollect(stub.tick(n))` sees the original elements, not
 * a single array chunk.
 */
const asRemoteEffectOrStream = (
  call: Effect.Effect<unknown, unknown>,
): Effect.Effect<unknown, unknown> => {
  const streamForm = Stream.unwrap(
    Effect.map(call, (value) =>
      Stream.isStream(value)
        ? (value as Stream.Stream<unknown, unknown>)
        : Array.isArray(value)
          ? Stream.fromIterable(value)
          : Stream.succeed(value),
    ),
  );
  return Object.assign(call, {
    [StreamTypeId]: (streamForm as any)[StreamTypeId],
    channel: (streamForm as any).channel,
  });
};

/**
 * The per-instance stub: every property access is a remote action call. The
 * returned value is BOTH an `Effect` (value methods) and a `Stream`
 * (streaming methods — collected to an array by the actor bridge,
 * re-expanded to elements by the stream form above).
 */
const makeRivetActorStub = (
  connection: RivetGatewayConnection,
  actorName: string,
  key: string,
): any =>
  new Proxy(
    {},
    {
      get: (obj, prop) => {
        if (prop in obj) return obj[prop as keyof typeof obj];
        if (typeof prop !== "string") return undefined;
        // Guard against thenable/inspection probing on the Proxy.
        if (prop === "then" || prop === "toJSON") return undefined;
        return (...args: unknown[]) =>
          asRemoteEffectOrStream(
            withHttpClient(
              Effect.gen(function* () {
                const client = yield* HttpClient.HttpClient;
                const params = new URLSearchParams({
                  "rvt-namespace":
                    connection.namespace ?? RIVET_ACTOR_NAMESPACE,
                  "rvt-method": "getOrCreate",
                  "rvt-key": key,
                  "rvt-runner": connection.pool ?? RIVET_RUNNER_POOL,
                  "rvt-token": connection.token,
                });
                const endpoint = connection.endpoint.replace(/\/+$/, "");
                const url = `${endpoint}/gateway/${encodeURIComponent(
                  actorName,
                )}/action/${encodeURIComponent(prop)}?${params.toString()}`;

                const response = yield* client
                  .execute(
                    HttpClientRequest.post(url).pipe(
                      HttpClientRequest.bodyText(
                        JSON.stringify({ args }),
                        "application/json",
                      ),
                    ),
                  )
                  .pipe(
                    Effect.flatMap((response) =>
                      response.status >= 300
                        ? response.text.pipe(
                            Effect.orElseSucceed(() => ""),
                            Effect.flatMap((body) => {
                              let code: string | undefined;
                              try {
                                code = (JSON.parse(body) as { code?: string })
                                  .code;
                              } catch {
                                // non-JSON error body
                              }
                              return Effect.fail(
                                new RivetGatewayError({
                                  status: response.status,
                                  code,
                                  body,
                                }),
                              );
                            }),
                          )
                        : Effect.succeed(response),
                    ),
                    // Transport failures and engine wake races are transient —
                    // bounded backoff, then surface.
                    Effect.retry({
                      while: (error): boolean =>
                        !(error instanceof RivetGatewayError) ||
                        transientStatus(error.status),
                      schedule: Schedule.exponential("500 millis"),
                      times: 5,
                    }),
                  );

                const value = (yield* response.json) as
                  | { output?: unknown }
                  | null
                  | undefined;
                return yield* decodeRpcResult(value?.output);
              }) as Effect.Effect<unknown, unknown, HttpClient.HttpClient>,
            ),
          );
      },
    },
  );

/**
 * The namespace client for one actor (Durable Object class):
 * `getByName(name)` addresses the instance keyed `name`, creating it on
 * first touch (`rvt-method=getOrCreate`).
 */
export const makeRivetActorClient = (
  connection: RivetGatewayConnection,
  actorName: string,
): DurableObjectNamespaceClient => ({
  getByName: (name: string) => makeRivetActorStub(connection, actorName, name),
});
