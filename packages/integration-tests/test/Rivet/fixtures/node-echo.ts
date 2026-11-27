/**
 * A class `Node.serve` hosts in the test's own process: a counter, and a
 * `fetch` that echoes the trace header its caller sent.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class NodeEcho extends Rivet.DurableObject<NodeEcho>()(
  "NodeEcho",
  { main: import.meta.url },
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      return {
        increment: () =>
          Effect.gen(function* () {
            const next = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
            yield* state.storage.put("count", next);
            return next;
          }),
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          return yield* HttpServerResponse.json({
            name: state.id.name,
            trace: request.headers["x-trace"] ?? null,
          });
        }),
      };
    }),
  ),
) {}
