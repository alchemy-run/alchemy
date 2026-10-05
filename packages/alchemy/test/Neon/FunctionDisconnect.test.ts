import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { makeFunctionBridge } from "@/Neon/FunctionBridge";
import { makeNativeFunctionBridge } from "@/Neon/FunctionNativeBridge";
import { makeFunctionRuntimeContext } from "@/Neon/FunctionRuntimeContext";

type Handler = (request: Request) => Promise<Response>;

// Mirrors Neon's host (neondatabase/neon-pkgs#636): the handler's Request has
// no signal, and the identity pump only waits on `drain`, so a client
// disconnect alone never cancels the body.
const neonLikeHost = (handler: Handler, pumpEnded: Deferred.Deferred<void>) =>
  Effect.acquireRelease(
    Effect.callback<http.Server>((resume) => {
      const server = http.createServer(async (req, res) => {
        const response = await handler(new Request(`http://${req.headers.host}${req.url}`));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        const reader = response.body!.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
          }
          res.end();
        } catch (error) {
          res.destroy(error as Error);
        }
        Effect.runFork(Deferred.succeed(pumpEnded, undefined));
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

// Read the first chunk, then drop the connection like a closed browser tab.
const disconnectAfterFirstChunk = (server: http.Server) =>
  Effect.callback<void, Error>((resume) => {
    const { port } = server.address() as AddressInfo;
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.once("data", () => {
        req.destroy();
        resume(Effect.void);
      });
    });
    req.once("error", (error) => resume(Effect.fail(error)));
  });

const tick = new TextEncoder().encode("tick\n".repeat(1024));

test.live(
  "Effect bridge closes the request scope when the client disconnects",
  () =>
    Effect.gen(function* () {
      const scopeClosed = yield* Deferred.make<void>();
      const streamClosed = yield* Deferred.make<void>();
      const pumpEnded = yield* Deferred.make<void>();
      const runtime = yield* Effect.sync(() => makeFunctionRuntimeContext("Disconnect"));
      yield* runtime.route(
        "/",
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(scopeClosed, undefined));
          return HttpServerResponse.stream(
            Stream.fromEffectRepeat(Effect.as(Effect.sleep("5 millis"), tick)).pipe(
              Stream.ensuring(Deferred.succeed(streamClosed, undefined)),
            ),
          );
        }),
      );
      const bridge = yield* Effect.sync(() =>
        makeFunctionBridge(Effect.succeed({ RuntimeContext: runtime })),
      );
      const server = yield* neonLikeHost(bridge.fetch, pumpEnded);
      yield* disconnectAfterFirstChunk(server);
      yield* Effect.all([
        Deferred.await(streamClosed),
        Deferred.await(scopeClosed),
        Deferred.await(pumpEnded),
      ]).pipe(Effect.timeout("5 seconds"));
    }).pipe(Effect.scoped),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);

test.live(
  "native handler bodies are cancelled when the client disconnects",
  () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      const pumpEnded = yield* Deferred.make<void>();
      let open = true;
      const native = makeNativeFunctionBridge({
        fetch: (_request: Request) =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull: (controller) =>
                new Promise<void>((resolve) =>
                  setTimeout(() => {
                    if (open) controller.enqueue(tick);
                    resolve();
                  }, 5),
                ),
              cancel: () => {
                open = false;
                Effect.runFork(Deferred.succeed(cancelled, undefined));
              },
            }),
          ),
      }) as { fetch: Handler };
      const server = yield* neonLikeHost(native.fetch, pumpEnded);
      yield* disconnectAfterFirstChunk(server);
      yield* Effect.all([Deferred.await(cancelled), Deferred.await(pumpEnded)]).pipe(
        Effect.timeout("5 seconds"),
      );
    }).pipe(Effect.scoped),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);

test.effect(
  "native bridge keeps the handler shape and upgrade responses",
  () =>
    Effect.gen(function* () {
      const upgrade = () => undefined;
      const upgradeResponse = Object.defineProperty(new Response(null), "status", {
        get: () => 101,
      });
      const bridged = makeNativeFunctionBridge({
        fetch: () => upgradeResponse,
        upgrade,
      }) as { fetch: Handler; upgrade: unknown };
      expect(bridged.upgrade).toBe(upgrade);
      // Outside a host `request` event there is no disconnect to observe.
      const response = yield* Effect.promise(() => bridged.fetch(new Request("http://x/")));
      expect(response).toBe(upgradeResponse);
      const bare = makeNativeFunctionBridge(() => new Response("bare"));
      expect(typeof bare).toBe("function");
    }),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);
