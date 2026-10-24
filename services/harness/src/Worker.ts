import { SessionError } from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Agent } from "./Agent.ts";
import { HarnessRpcs, type ListedSession } from "./HarnessRpcs.ts";
import { Sessions, SESSIONS_INDEX } from "./Sessions.ts";

/** The web UI is served from another origin. */
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

/** The call reached no Durable Object (as opposed to the session's own errors). */
const isRpcClientError = <E>(error: E): error is Extract<E, RpcClientError.RpcClientError> =>
  Schema.is(RpcClientError.RpcClientError)(error);

const unreachable = (error: RpcClientError.RpcClientError) =>
  SessionError.make({ message: `the session's agent could not be reached: ${error.message}` });

/** A Durable Object that can't be reached fails the call as the session's error. */
const reachable = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(Effect.catchIf(isRpcClientError<E>, (error) => error.pipe(unreachable, Effect.fail)));

const reachableStream = <A, E, R>(self: Stream.Stream<A, E, R>) =>
  self.pipe(Stream.catchIf(isRpcClientError<E>, (error) => error.pipe(unreachable, Stream.fail)));

/**
 * The harness's API: `HarnessRpcs` (Effect RPC over HTTP, NDJSON so streams
 * work). Each call names its session and goes to that session's Durable
 * Object (one per issue, with its own container); `list` reads the
 * session index.
 */
export default Cloudflare.Worker(
  "CodingAgents",
  // Under `alchemy dev` the web UI takes the default port.
  { main: import.meta.url, dev: { port: 1338 } },
  Effect.gen(function* () {
    const agents = yield* Agent;
    const sessions = yield* Sessions;

    /** The session's Durable Object. */
    const agent = (sessionId: string) => agents.getByName(sessionId);

    const handlers = HarnessRpcs.toLayer({
      // Each session with its agent's and machine's state, from the
      // session's records (no machine is started).
      list: () =>
        sessions
          .getByName(SESSIONS_INDEX)
          .list()
          .pipe(
            Effect.flatMap((listed) =>
              Effect.forEach(
                listed,
                (session) =>
                  agent(session.id).pipe(
                    Effect.flatMap((client) => client.summary({ sessionId: session.id })),
                    Effect.map((summary): ListedSession => ({
                      ...session,
                      state: summary.machine,
                      ...(summary.session
                        ? { agent: summary.session.state, costUsd: summary.session.usage.costUsd }
                        : {}),
                    })),
                    // Unreachable, or still on an older version: list it anyway.
                    Effect.catchCause(() =>
                      Effect.succeed<ListedSession>({ ...session, state: "unknown" }),
                    ),
                  ),
                { concurrency: 16 },
              ),
            ),
            Effect.orElseSucceed((): ReadonlyArray<ListedSession> => []),
          ),
      start: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.start(payload)),
          reachable,
        ),
      prompt: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.prompt(payload)),
          reachable,
        ),
      steer: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.steer(payload)),
          reachable,
        ),
      interrupt: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.interrupt(payload)),
          reachable,
        ),
      setModel: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.setModel(payload)),
          reachable,
        ),
      respond: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.respond(payload)),
          reachable,
        ),
      result: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.result(payload)),
          reachable,
        ),
      events: (payload) =>
        Stream.unwrap(
          Effect.map(agent(payload.sessionId), (client) => client.events(payload)),
        ).pipe(reachableStream),
      info: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.info(payload)),
          reachable,
        ),
      terminal: (payload) =>
        Stream.unwrap(
          Effect.map(agent(payload.sessionId), (client) => client.terminal(payload)),
        ).pipe(reachableStream),
      machine: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.machine(payload)),
          reachable,
        ),
      summary: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.summary(payload)),
          reachable,
        ),
      settle: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.settle(payload)),
          reachable,
        ),
      suspend: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.suspend(payload)),
          reachable,
        ),
      resume: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.resume(payload)),
          reachable,
        ),
      terminalInput: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.terminalInput(payload)),
          reachable,
        ),
      terminalResize: (payload) =>
        agent(payload.sessionId).pipe(
          Effect.flatMap((client) => client.terminalResize(payload)),
          reachable,
        ),
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method === "OPTIONS") {
          // Allow what the browser asks for: Effect's HttpClient adds trace
          // headers (`traceparent`, `b3`) to every RPC request.
          return HttpServerResponse.empty({
            status: 204,
            headers: {
              ...cors,
              "access-control-allow-headers":
                request.headers["access-control-request-headers"] ?? "content-type",
            },
          });
        }
        // The server is built per request, in the request's scope (its
        // handlers reach the Durable Objects with this request's context).
        const rpc = yield* RpcServer.toHttpEffect(HarnessRpcs).pipe(
          Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
        );
        return HttpServerResponse.setHeaders(yield* rpc, cors);
      }),
    };
  }),
);
