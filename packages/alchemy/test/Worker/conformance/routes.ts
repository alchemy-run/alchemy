/**
 * The shared conformance HTTP surface — the `fetch` handler every engine's
 * conformance worker serves. Routes map 1:1 onto the spec in `spec.ts`.
 *
 * Like `counter.ts`, this file must stay engine-neutral.
 */
import type { HttpEffect } from "@/Http";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Counter } from "./counter.ts";

type Namespace = { getByName: (name: string) => any };

/** Build the conformance `fetch` handler over a Durable Object namespace. */
export const conformanceFetch = (counters: Namespace): HttpEffect<any> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://conformance");
    const [group, cell, action] = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0);

    if (!group || !cell) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const counter = counters.getByName(cell);

    switch (`${group}/${action ?? ""}`) {
      case "kv/increment":
        return yield* HttpServerResponse.json({
          value: yield* counter.increment().pipe(Effect.orDie),
        });
      case "kv/get":
        return yield* HttpServerResponse.json({
          value: yield* counter.get().pipe(Effect.orDie),
        });
      case "kv/list":
        return yield* HttpServerResponse.json({
          keys: yield* counter
            .listKeys(url.searchParams.get("prefix") ?? "")
            .pipe(Effect.orDie),
        });
      case "kv/delete":
        return yield* HttpServerResponse.json({
          deleted: yield* counter
            .removeKey(url.searchParams.get("key") ?? "")
            .pipe(Effect.orDie),
        });

      case "sql/insert":
        yield* counter
          .sqlInsert(url.searchParams.get("v") ?? "")
          .pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ ok: true });
      case "sql/all":
        return yield* HttpServerResponse.json({
          rows: yield* counter.sqlAll().pipe(Effect.orDie),
        });

      case "alarm/arm":
        yield* counter
          .armAlarm(Number(url.searchParams.get("ms") ?? "1000"))
          .pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ ok: true });
      case "alarm/peek":
        return yield* HttpServerResponse.json({
          time: yield* counter.peekAlarm().pipe(Effect.orDie),
        });
      case "alarm/cancel":
        yield* counter.cancelAlarm().pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ ok: true });
      case "alarm/fired":
        return yield* HttpServerResponse.json({
          count: yield* counter.firedCount().pipe(Effect.orDie),
        });
      default:
        break;
    }

    // `/stream/{cell}?n=` and `/fail/{cell}` have no third segment.
    if (group === "stream") {
      const n = Number(url.searchParams.get("n") ?? "3");
      const values = yield* Stream.runCollect(counter.tick(n)).pipe(
        Effect.orDie,
      );
      return yield* HttpServerResponse.json({ values: [...values] });
    }
    if (group === "fail") {
      const result = yield* counter.boom().pipe(
        Effect.map(() => ({ tag: "unexpected-success" })),
        Effect.catch((error: unknown) =>
          Effect.succeed({ tag: (error as { _tag?: string })?._tag }),
        ),
      );
      return yield* HttpServerResponse.json(result);
    }
    return HttpServerResponse.text("Not Found", { status: 404 });
  }) as HttpEffect<any>;

export type { Counter };
