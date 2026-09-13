/**
 * The shared conformance HTTP surface — the `fetch` handler every engine's
 * conformance worker serves. Routes map 1:1 onto the spec in `spec.ts`.
 *
 * Like `counter.ts`, this file must stay engine-neutral: the namespace it
 * takes is typed against {@link CounterShape} alone, so a native
 * `Cloudflare.DurableObject` namespace, a `Celld.bindWorker` stub and a
 * `Rivet.bindWorker` stub all satisfy it.
 */
import type { HttpEffect } from "@/Http";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Counter, CounterShape } from "./counter.ts";

/** Any namespace whose stubs mirror {@link CounterShape}. */
export interface CounterNamespace {
  getByName: (name: string) => CounterShape;
}

/** Build the conformance `fetch` handler over a Durable Object namespace. */
export const conformanceFetch = (
  counters: CounterNamespace,
): HttpEffect<RuntimeContext> =>
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
          value: yield* counter.increment(),
        });
      case "kv/get":
        return yield* HttpServerResponse.json({ value: yield* counter.get() });
      case "kv/list":
        return yield* HttpServerResponse.json({
          keys: yield* counter.listKeys(url.searchParams.get("prefix") ?? ""),
        });
      case "kv/delete":
        return yield* HttpServerResponse.json({
          deleted: yield* counter.removeKey(url.searchParams.get("key") ?? ""),
        });

      case "sql/clear":
        yield* counter.sqlClear();
        return yield* HttpServerResponse.json({ ok: true });
      case "sql/insert":
        yield* counter.sqlInsert(url.searchParams.get("v") ?? "");
        return yield* HttpServerResponse.json({ ok: true });
      case "sql/all":
        return yield* HttpServerResponse.json({
          rows: yield* counter.sqlAll(),
        });

      case "alarm/arm":
        yield* counter.armAlarm(Number(url.searchParams.get("ms") ?? "1000"));
        return yield* HttpServerResponse.json({ ok: true });
      case "alarm/peek":
        return yield* HttpServerResponse.json({
          time: yield* counter.peekAlarm(),
        });
      case "alarm/cancel":
        yield* counter.cancelAlarm();
        return yield* HttpServerResponse.json({ ok: true });
      case "alarm/fired":
        return yield* HttpServerResponse.json({
          count: yield* counter.firedCount(),
        });
      default:
        break;
    }

    // `/stream/{cell}?n=` and `/fail/{cell}` have no third segment.
    if (group === "stream") {
      const n = Number(url.searchParams.get("n") ?? "3");
      const values = yield* Stream.runCollect(counter.tick(n));
      return yield* HttpServerResponse.json({ values: [...values] });
    }
    if (group === "fail") {
      // The typed failure round-trips the stub as its own tag.
      const result = yield* counter.boom().pipe(
        Effect.map((): { tag: string } => ({ tag: "unexpected-success" })),
        Effect.catchTag("CounterBoom", (error) =>
          Effect.succeed({ tag: error._tag }),
        ),
      );
      return yield* HttpServerResponse.json(result);
    }
    return HttpServerResponse.text("Not Found", { status: 404 });
  });

export type { Counter };
