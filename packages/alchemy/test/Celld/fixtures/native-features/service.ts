import { Namespace } from "@/Celld/KV/Namespace.ts";
import { ReadWriteNamespace } from "@/Celld/KV/ReadWriteNamespace.ts";
import { ReadWriteNamespaceBinding } from "@/Celld/KV/ReadWriteNamespaceBinding.ts";
import type { TailEvent } from "@/Celld/TailEvent.ts";
import { Worker } from "@/Celld/Worker.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class NativeService extends Worker<NativeService>()(
  "NativeService",
  { main: import.meta.url },
  Effect.gen(function* () {
    const observations = yield* ReadWriteNamespace(
      yield* Namespace.ref("OBSERVATIONS"),
    );
    const observe = (key: string, value: unknown) =>
      Effect.sync(() => JSON.stringify(value)).pipe(
        Effect.flatMap((json) => observations.put(key, json)),
      );
    return {
      tail: (events: readonly TailEvent[]) =>
        Effect.forEach(events, (event) =>
          Effect.gen(function* () {
            const url = yield* Effect.sync(
              () => new URL(event.event.request.url),
            );
            const id = url.searchParams.get("id");
            if (!id) return;
            yield* Effect.addFinalizer(() =>
              observe(`tail:closed:${id}`, { closed: true }).pipe(Effect.orDie),
            );
            yield* observe(`tail:${id}`, event);
            if (url.searchParams.get("mode") === "tail-failure")
              return yield* Effect.die(
                new Error("native-tail-handler-failure"),
              );
          }),
        ),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const body = yield* request.text;
        return yield* HttpServerResponse.json(
          {
            service: "native-service",
            method: request.method,
            body,
            token: request.headers["x-native-token"],
          },
          { headers: { "x-native-service": "yes" } },
        );
      }),
    };
  }).pipe(Effect.orDie, Effect.provide(ReadWriteNamespaceBinding)),
) {}
