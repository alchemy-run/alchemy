/**
 * The HTTP routes of every suite's front: each calls the entities,
 * workflows and journals through their gateways, whatever runtime serves it.
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { AuthClient, CallerToken } from "./auth.ts";
import { Counters, LaterAdd } from "./counter.ts";
import { Greeters } from "./greeter.ts";
import { Ledgers } from "./ledger.ts";
import type { tallyOn } from "./legacy.ts";
import { Turnstiles } from "./turnstile.ts";
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
    const ledgers = yield* Ledgers;
    const turnstiles = yield* Turnstiles;
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
          case "add-forget":
            // Twice, without waiting: a primary key runs once either way.
            yield* counter.Add({ operationId: arg!, amount: 5 }, { discard: true });
            yield* counter.Add({ operationId: arg!, amount: 5 }, { discard: true });
            return yield* json({ value: "sent" });
          case "later": {
            const at = (yield* Clock.currentTimeMillis) + Number(arg);
            yield* counter.AddLater(new LaterAdd({ operationId: `later-${id}`, amount: 5, at }), {
              discard: true,
            });
            return yield* json({ value: "sent", at });
          }
          case "later-ask": {
            // Two callers wait for one message, which runs at its time.
            const sent = yield* Clock.currentTimeMillis;
            const message = new LaterAdd({
              operationId: `later-ask-${id}`,
              amount: 5,
              at: sent + Number(arg),
            });
            const values = yield* Effect.all(
              [counter.AddLater(message), counter.AddLater(message)],
              {
                concurrency: 2,
              },
            );
            return yield* json({ values, elapsed: (yield* Clock.currentTimeMillis) - sent });
          }
          case "ran-at":
            return yield* json({ value: yield* counter.RanAt() });
          case "flaky":
            return yield* json({ value: yield* counter.Flaky() });
          case "fork": {
            // `Release` reaches the instance while `Wait` holds its only permit.
            const [waited] = yield* Effect.all(
              [counter.Wait(), Effect.delay(counter.Release(), "500 millis")],
              { concurrency: 2 },
            );
            return yield* json({ value: waited });
          }
          case "hang":
            return yield* json({
              value: yield* (yield* greeters.getByName("front")).HangCounter({ id }),
            });
          case "interrupted":
            return yield* json({ value: yield* counter.WasInterrupted() });
          case "settle":
            return yield* json({
              value: yield* (yield* greeters.getByName("front")).AbandonCounter({
                id,
                call: "Settle",
              }),
            });
          case "settled":
            return yield* json({ value: yield* counter.Settled() });
          case "queued-interrupt": {
            // `Mark` waits behind `Wait`, and its caller gives up before its turn.
            const waiting = yield* Effect.forkChild(counter.Wait());
            yield* Effect.sleep("300 millis");
            const abandoned = yield* (yield* greeters.getByName("front")).AbandonCounter({
              id,
              call: "Mark",
            });
            yield* Effect.sleep("500 millis");
            yield* counter.Release();
            const waited = yield* Fiber.join(waiting);
            yield* Effect.sleep("500 millis");
            return yield* json({ waited, abandoned, marked: yield* counter.Marked() });
          }
          case "countdown": {
            const values = yield* Stream.runCollect(
              counter.Countdown({ operationId: arg!, n: 5, everyMillis: 300 }),
            );
            return yield* json({ values: [...values], runs: yield* counter.CountdownRuns() });
          }
          case "builds": {
            const ledger = yield* ledgers.getByName(id);
            yield* Effect.all(
              Array.from({ length: 5 }, () => ledger.Balance()),
              { concurrency: "unbounded" },
            );
            return yield* json({ value: yield* ledger.Builds() });
          }
          case "built-at": {
            const ledger = yield* ledgers.getByName(id);
            const builtAt = yield* ledger.BuiltAt();
            return yield* json({ builtAt, age: (yield* Clock.currentTimeMillis) - builtAt });
          }
          case "note":
            return yield* json(
              yield* (yield* ledgers.getByName(id))
                .Note({ txId: `note-${arg}`, text: "x".repeat(Number(arg)) })
                .pipe(
                  Effect.map((value) => ({ value })),
                  Effect.catchTag("PersistenceError", (error) =>
                    Effect.succeed({ tag: error._tag }),
                  ),
                ),
            );
          case "pass-race": {
            // Four at once, to a mailbox that holds two.
            const turnstile = yield* turnstiles.getByName(id);
            const results = yield* Effect.all(
              Array.from({ length: 4 }, () =>
                turnstile.Pass().pipe(
                  Effect.as("passed"),
                  Effect.catchTag("MailboxFull", () => Effect.succeed("full")),
                ),
              ),
              { concurrency: "unbounded" },
            );
            return yield* json({ results });
          }
          case "pass-once-race": {
            // Five persisted messages at once: each waits for room.
            const turnstile = yield* turnstiles.getByName(id);
            const values = yield* Effect.all(
              Array.from({ length: 5 }, (_, i) => turnstile.PassOnce({ ticket: `t-${i}` })),
              { concurrency: "unbounded" },
            );
            return yield* json({ values, passed: yield* turnstile.Passed() });
          }
          case "credit-race": {
            const ledger = yield* ledgers.getByName(id);
            const values = yield* Effect.all(
              Array.from({ length: 5 }, () => ledger.Credit({ txId: "tx-1", amount: 10 })),
              { concurrency: "unbounded" },
            );
            return yield* json({ values, balance: yield* ledger.Balance() });
          }
          case "remember":
            yield* (yield* ledgers.getByName(id)).Remember({ value: Number(arg) });
            return yield* json({ value: "ok" });
          case "pin":
            yield* (yield* ledgers.getByName(id)).Pin();
            return yield* json({ value: "ok" });
          case "recall":
            return yield* json({ value: yield* (yield* ledgers.getByName(id)).Recall() });
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
