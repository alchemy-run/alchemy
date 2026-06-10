import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { KV } from "./KV.ts";
import NotifyWorkflow from "./NotifyWorkflow.ts";

interface AddInstance {
  exports: {
    add(a: number, b: number): number;
  };
}
interface QueueMessage {
  id: string;
  body: {
    text: string;
    sentAt: number;
  };
}

export default class EffectWorker extends Cloudflare.Worker<EffectWorker>()(
  "EffectWorker",
  {
    main: import.meta.filename,
    dev: {
      port: Config.number("PORT").pipe(Config.withDefault(1338)),
    },
  },
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(KV);
    const queue = yield* Cloudflare.Queue("EffectWorkerQueue");
    const queueBinding = yield* Cloudflare.Queue.bind(queue);
    const queueMessages = yield* QueueMessages;
    const workflow = yield* NotifyWorkflow;

    yield* Cloudflare.messages<QueueMessage["body"]>(queue).subscribe(
      (stream) =>
        Stream.runForEach(stream, (msg) =>
          queueMessages
            .getByName("global")
            .put({ id: msg.id, body: msg.body })
            .pipe(Effect.asVoid),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://internal");
        if (url.pathname === "/wasm") {
          const instance = yield* Effect.promise(async () => {
            // This is dynamically imported so that the WASM import doesn't occur at deploy-time, which works in Bun but fails in Node.
            const wasm = await import("./modules/wasm-example.wasm");
            return (await WebAssembly.instantiate(wasm.default)) as AddInstance;
          });
          return yield* HttpServerResponse.json({
            result: instance.exports.add(3, 4),
          });
        } else if (url.pathname.startsWith("/workflow/start/")) {
          const roomId = url.pathname.split("/workflow/start/")[1];
          if (!roomId) {
            return yield* HttpServerResponse.json(
              { error: "roomId is required" },
              { status: 400 },
            );
          }
          const instance = yield* workflow.create({
            roomId,
            message: "hello from workflow",
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        } else if (url.pathname.startsWith("/workflow/status/")) {
          const instanceId = url.pathname.split("/workflow/status/")[1];
          if (!instanceId) {
            return yield* HttpServerResponse.json(
              { error: "instanceId is required" },
              { status: 400 },
            );
          }
          const instance = yield* workflow.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        } else if (url.pathname.startsWith("/queue/send")) {
          const body = yield* request.json;
          yield* queueBinding.send(body).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ sent: body });
        } else if (url.pathname.startsWith("/queue/messages")) {
          const messages = yield* queueMessages.getByName("global").list();
          return yield* HttpServerResponse.json(messages);
        }
        const value = yield* kv.list().pipe(Effect.orDie);
        return yield* HttpServerResponse.json(value);
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.KVNamespaceBindingLive,
      Cloudflare.QueueBindingLive,
      Cloudflare.QueueEventSourceLive,
    ]),
  ),
) {}

export class QueueMessages extends Cloudflare.DurableObjectNamespace<QueueMessages>()(
  "QueueMessages",
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        put: Effect.fn(function* (message: QueueMessage) {
          yield* state.storage.put(message.id, message);
        }),
        list: Effect.fn(function* () {
          const messages = new Map<string, QueueMessage>(
            state.storage.kv.list<QueueMessage>(),
          );
          return Array.from(messages.values());
        }),
      };
    }),
  ),
) {}
