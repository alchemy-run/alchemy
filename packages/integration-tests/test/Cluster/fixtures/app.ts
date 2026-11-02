/**
 * The HTTP routes of every suite's front: each calls the entities,
 * workflows and journals through their gateways, whatever runtime serves it.
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { AuthClient, CallerToken } from "./auth.ts";
import { Counters } from "./counter.ts";
import { Greeters } from "./greeter.ts";
import type { tallyOn } from "./legacy.ts";
import { workflowApp } from "./workflows/app.ts";
import { Greet } from "./workflows/workflows.ts";

/**
 * The front, given the external program's entity as its host deploys it
 * (none on hosts that can't run one).
 */
export const frontApp = <R>(Tally?: ReturnType<typeof tallyOn<R>>) =>
  Effect.gen(function* () {
    const counters = yield* Counters;
    const greeters = yield* Greeters;
    const tallies = Tally === undefined ? undefined : yield* Tally;
    const workflows = yield* workflowApp;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://front");
        const [route, id = "x", arg] = url.pathname.split("/").filter((s) => s.length > 0);
        if (route === "wf") return yield* workflows(url);
        const counter = yield* counters.getByName(id);
        const json = (value: unknown) => HttpServerResponse.json(value);
        switch (route) {
          case "increment":
            return yield* json({ value: yield* counter.Increment({ amount: Number(arg ?? 1) }) });
          case "get":
            return yield* json({ value: yield* counter.Get() });
          case "add":
            return yield* json({ value: yield* counter.Add({ operationId: arg!, amount: 5 }) });
          case "whoami":
            return yield* json({ value: yield* counter.Whoami() });
          case "boom":
            return yield* json(
              yield* counter.Boom().pipe(
                Effect.as({ tag: "unexpected-success" }),
                Effect.catchTag("CounterBoom", (error) => Effect.succeed({ tag: error._tag })),
              ),
            );
          case "tick":
            return yield* json({
              values: [...(yield* Stream.runCollect(counter.Tick({ n: Number(arg ?? 3) })))],
            });
          case "greet":
            return yield* json({
              value: yield* (yield* greeters.getByName("front")).Greet({ name: id }),
            });
          case "tally":
            if (tallies === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
            return yield* json({
              value: yield* (yield* tallies.getByName(id)).Add({ amount: Number(arg ?? 1) }),
            });
          case "secret":
            return yield* json(
              yield* counter.Secret().pipe(
                Effect.map((value) => ({ value })),
                Effect.catchTag("Unauthorized", (error) => Effect.succeed({ tag: error._tag })),
                arg === undefined ? (effect) => effect : Effect.provideService(CallerToken, arg),
              ),
            );
          case "forget":
            yield* counter.Increment({ amount: Number(arg ?? 1) }, { discard: true });
            return yield* json({ value: "sent" });
          case "ready":
            return HttpServerResponse.text("ok");
          default:
            return HttpServerResponse.text("Not Found", { status: 404 });
        }
      }).pipe(
        Effect.provide(AuthClient),
        // A failed call answers with its cause, which the tests print.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Cluster.WorkflowEngine(Greet)));
