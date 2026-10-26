import * as Celld from "@alchemy.run/celld";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { FeatureService, Observations } from "./resources.ts";

export default FeatureService.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const observations = yield* Celld.KV.ReadWriteNamespace(yield* Observations);
    const observe = (key: string, value: unknown) =>
      Effect.sync(() => JSON.stringify(value)).pipe(
        Effect.flatMap((json) => observations.put(key, json)),
      );
    return {
      tail: (events: readonly Celld.TailEvent[]) =>
        Effect.forEach(events, (event) =>
          Effect.gen(function* () {
            const url = yield* Effect.sync(() => new URL(event.event.request.url));
            const id = url.searchParams.get("id");
            if (!id) return;
            yield* observe(`tail:${id}`, event);
          }),
        ),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const body = yield* request.text;
        return yield* HttpServerResponse.json(
          {
            service: "feature-service",
            method: request.method,
            body,
            token: request.headers["x-feature-token"],
          },
          { headers: { "x-feature-service": "yes" } },
        );
      }),
    };
  }).pipe(Effect.orDie, Effect.provide(Celld.KV.ReadWriteNamespaceBinding)),
);
