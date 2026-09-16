/**
 * The driver under test, exposed over HTTP: one route per actor verb.
 *
 * Note what the Worker does NOT contain — no Durable Object class, no
 * namespace wiring, no run registry. `Cloudflare.AI.DriverCloudflare`
 * declares the runs DO inside itself and is discovered as a binding
 * because the layer yields it while building, and the whole org is ONE
 * layer provided to the init effect. A Durable Object activation
 * shares that same memoized build, which is how a charter (code, and
 * so un-serializable) reaches a run without ever crossing the wire.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Agents, Ledger, Scribe, Supervisor } from "./DriverAgents.ts";

export default class KernelTestWorker extends Cloudflare.Worker<KernelTestWorker>()(
  "DriverCloudflareTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const scribe = yield* Scribe;
    const supervisor = yield* Supervisor;
    const ledger = yield* Ledger;
    const gateway = yield* Cloudflare.AI.Sessions;
    const actors = { Scribe: scribe, Supervisor: supervisor };

    /** Surface an Exit as JSON (always 200 — the test reads the shape):
     *  `value` on success, `failure` for a typed failure, `error` for a
     *  defect. A deployed test can only be debugged through its
     *  responses. */
    const respond = <A, E>(exit: Exit.Exit<A, E>) =>
      Exit.isSuccess(exit)
        ? HttpServerResponse.json({ value: exit.value })
        : Cause.hasFails(exit.cause)
          ? HttpServerResponse.json({ failure: Cause.squash(exit.cause) })
          : HttpServerResponse.json({ error: Cause.pretty(exit.cause) });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const key = url.searchParams.get("key") ?? "default";
        const input = url.searchParams.get("input") ?? "hello";
        const actor =
          actors[(url.searchParams.get("agent") ?? "Scribe") as "Scribe"];

        // the live view: ws(s)://…/attach/<agent>/<key>
        if (url.pathname.startsWith("/attach/")) {
          const [, , agent, ...rest] = url.pathname.split("/");
          return yield* gateway.attach(agent!, rest.join("/"), request);
        }

        switch (url.pathname) {
          // admit + join: resolves at `AI.reply`, or at quiescence
          case "/dispatch": {
            // surface failures as text instead of an opaque 500 — a
            // deployed test can only be debugged through its responses
            const result = yield* Effect.exit(actor.dispatch(input, { key }));
            if (Exit.isSuccess(result)) {
              return yield* HttpServerResponse.json({ answer: result.value });
            }
            const detail = Cause.pretty(result.cause);
            yield* Effect.logError(`[fixture] dispatch failed: ${detail}`);
            return yield* HttpServerResponse.json(
              { error: detail },
              { status: 500 },
            );
          }
          // admit, fire-and-forget
          case "/send": {
            const sent = yield* Effect.exit(actor.send(input, { key }));
            if (Exit.isSuccess(sent)) {
              return yield* HttpServerResponse.json({ sent: true });
            }
            const detail = Cause.pretty(sent.cause);
            yield* Effect.logError(`[fixture] send failed: ${detail}`);
            return yield* HttpServerResponse.json(
              { error: detail },
              { status: 500 },
            );
          }
          // key-addressed input: wakes a parked run
          case "/steer": {
            yield* actor.steer(key, input);
            return yield* HttpServerResponse.json({ steered: true });
          }
          case "/settle": {
            yield* actor.settle(key, { reason: input });
            return yield* HttpServerResponse.json({ settled: true });
          }
          // the operator's switches, as the org's agent routes call them
          case "/stop": {
            const agent = url.searchParams.get("agent") ?? "Scribe";
            yield* gateway.stop(agent, key);
            return yield* HttpServerResponse.json({ stopped: true });
          }
          case "/interrupt": {
            const agent = url.searchParams.get("agent") ?? "Scribe";
            yield* gateway.interrupt(agent, key);
            return yield* HttpServerResponse.json({ interrupted: true });
          }
          // the undo for stop: the session reopens AND picks its work
          // back up — a round runs in its DO with no input sent
          case "/resume": {
            const agent = url.searchParams.get("agent") ?? "Scribe";
            yield* gateway.resume(agent, key);
            return yield* HttpServerResponse.json({ resumed: true });
          }
          // the transcript's observation types, in order — what the
          // views project; storage-only, never wakes the session
          case "/history": {
            const agent = url.searchParams.get("agent") ?? "Scribe";
            const log = yield* gateway.history(agent, key);
            return yield* HttpServerResponse.json({
              types: log.map((observation) => observation.type),
            });
          }
          // the eraser — `Sessions.remove`, as the org's thread DELETE
          // calls it; `?machine=false` spares the machine
          case "/remove": {
            const agent = url.searchParams.get("agent") ?? "Scribe";
            yield* gateway.remove(agent, key, {
              machine: url.searchParams.get("machine") !== "false",
            });
            return yield* HttpServerResponse.json({ removed: true });
          }
          // the directory, as the session index has it
          case "/list": {
            return yield* HttpServerResponse.json(yield* gateway.list());
          }
          // the agent as an OBJECT: `at(key)` + methods, each an RPC hop
          // into the session's own DO —
          //   /ledger?key=k&op=open&owner=ada&opening=10
          //   /ledger?key=k&op=deposit&amount=5
          case "/ledger": {
            const amount = Number(url.searchParams.get("amount") ?? "0");
            const owner = url.searchParams.get("owner") ?? "nobody";
            const opening = Number(url.searchParams.get("opening") ?? "0");
            const account = ledger.at(key);
            switch (url.searchParams.get("op")) {
              case "open":
                return yield* respond(
                  yield* Effect.exit(account.open({ owner, opening })),
                );
              case "deposit":
                return yield* respond(
                  yield* Effect.exit(account.deposit(amount)),
                );
              case "withdraw":
                return yield* respond(
                  yield* Effect.exit(account.withdraw(amount)),
                );
              case "statement":
                return yield* respond(yield* Effect.exit(account.statement()));
              case "dispatch":
                return yield* respond(
                  yield* Effect.exit(account.dispatch(input)),
                );
              case "stop":
                return yield* respond(yield* Effect.exit(account.stop()));
              case "destroy":
                return yield* respond(yield* Effect.exit(account.destroy()));
              default:
                return yield* respond(
                  yield* Effect.exit(
                    (
                      account as unknown as {
                        nope: () => Effect.Effect<unknown>;
                      }
                    ).nope(),
                  ),
                );
            }
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(Effect.provide(Agents)),
) {}
