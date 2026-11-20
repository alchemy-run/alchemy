/**
 * The HTTP routes of the Domain conformance suite, served by each
 * platform's front over the conformance model. Every route is a GET that
 * answers JSON.
 *
 * - `/increment/:id?by=n` sends `Increment`; `{ accepted: total }` or `{ rejected: tag }`;
 *   `&command=c` sends it under the command id `c`
 * - `/again/:id?by=n` sends `Increment` twice under one command id
 * - `/give/:from?to=id&by=n&id=commandId` sends `Give`, decided across both counters;
 *   `{ accepted: total, commits }` or `{ rejected: tag }`
 * - `/counter/:id`, `/echo/:id`, `/total/:id` read the counter, what the saga wrote, the view
 * - `/totals/:id?order=&take=&after=` lists a page of the view's entries
 * - `/hidden/:id?version=n` waits, server-side, until the view no client may read has folded `n` commits
 * - `/record/:id?by=n` sends `Increment`, waits for `TotalWriter.caughtUp`, then lists what it recorded
 * - `/tally/:id?by=n` sends `Increment` to a counter of the rebuild case, waits for the tallies
 *   to catch up, then lists its run's; `/generation` answers `TallyWriter`'s generation
 * - `/place/:id`, `/release/:id`, `/hold/:id` place, release and read a hold
 * - `/import/:id?n=&id=commandId&expected=&at=ms&step=&on=echo` imports `n` events adding 1
 *   into the counter (or the echo), the i-th committed at `ms + i * step` when `at` is given;
 *   `{ version }`, `{ rejected: tag, version }` or `{ rejected: tag, index }`
 * - `/times/:id` reads when the counter's first and latest events were committed
 * - `/api` serves {@link ConformanceApi}: calls over HTTP, live reads over WebSockets
 * - `/bench/:id?shape=&n=&consistency=&fresh=&lag=` times `n` commands sent one after
 *   another through {@link LatencyApi}, from inside the front: see `latency.ts`
 */
import type { ImportOutOfOrder, UnexpectedVersion } from "@alchemy.run/domain";
import * as Model from "@alchemy.run/domain/Model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import { One, OneView } from "./latency-model.ts";
import {
  ConformanceApi,
  Counter,
  CounterTimes,
  CounterTotal,
  Echo,
  Give,
  Giving,
  HiddenTotal,
  Hold,
  Incremented,
  Increment,
  LatencyApi,
  Mirrored,
  PlaceHold,
  Recorded,
  ReleaseHold,
  Tallies,
  tallyKey,
  TotalWriter,
} from "./model.ts";

/** The front's `fetch`, built once the model's services are provided. */
export const app = Effect.gen(function* () {
  const counters = yield* Counter;
  const echoes = yield* Echo;
  const totals = yield* CounterTotal;
  const times = yield* CounterTimes;
  const holds = yield* Hold;
  const giving = yield* Giving;
  const hidden = yield* HiddenTotal;
  const api = yield* ConformanceApi;
  const recorded = yield* Recorded;
  const tallies = yield* Tallies;
  const progress = yield* TotalWriter.Progress;
  const internals = yield* Model.Internals;
  const ones = yield* OneView;
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://front");
    const [, action, raw] = url.pathname.split("/");
    const id = decodeURIComponent(raw ?? "");
    const by = Number(url.searchParams.get("by") ?? "1");
    const increment = (commandId?: string) =>
      counters.send(new Increment({ id, by }), commandId === undefined ? {} : { commandId }).pipe(
        Effect.map((receipt) => ({ accepted: receipt.reply.total, version: receipt.version })),
        Effect.catchTag("TooBig", (rejection) => Effect.succeed({ rejected: rejection._tag })),
      );
    switch (action) {
      case "api":
        return yield* api.fetch;
      case "bench": {
        const shape = url.searchParams.get("shape") ?? "one";
        const n = Number(url.searchParams.get("n") ?? "10");
        const fresh = url.searchParams.get("fresh") === "1";
        const lag = url.searchParams.get("lag") === "1";
        const consistency =
          url.searchParams.get("consistency") === "eventual" ? "eventual" : "strong";
        const bench = yield* LatencyApi.clientInProcess.pipe(
          Effect.provideService(Model.Internals, internals),
        );
        const options = { consistency } as const;
        const version = <E>(sent: Effect.Effect<{ readonly version: number }, E>) =>
          sent.pipe(
            Effect.map((receipt) => receipt.version),
            Effect.orDie,
          );
        const send = (key: string): Effect.Effect<number> => {
          switch (shape) {
            case "bare":
              return version(bench.TickBare({ id: key }, options));
            case "four":
              return version(bench.TickFour({ id: key }, options));
            case "chain":
              return version(bench.TickChain({ id: key }, options));
            case "shared":
              return version(bench.TickShared({ id: key, group: id }, options));
            case "counter":
              return version(bench.Increment({ id: key, by: 1 }, options));
            default:
              return version(bench.TickOne({ id: key }, options));
          }
        };
        // What each command took, and with `lag`: how long after its answer the
        // view had it, and how many reads of the view that took.
        const ms: Array<number> = [];
        const behind: Array<number> = [];
        const reads: Array<number> = [];
        for (let i = 0; i < n; i++) {
          const key = fresh ? `${id}-${i}` : id;
          const started = Date.now();
          const committed = yield* send(key);
          const answered = Date.now();
          ms.push(answered - started);
          if (lag) {
            let tries = 0;
            while (true) {
              tries += 1;
              const view = yield* ones.get(One.ref(key)).pipe(Effect.orDie);
              if (Option.isSome(view) && view.value.count >= committed) break;
            }
            behind.push(Date.now() - answered);
            reads.push(tries);
          }
        }
        return yield* HttpServerResponse.json({ ms, behind, reads });
      }
      case "ready":
        return HttpServerResponse.text("ok");
      case "increment":
        return yield* HttpServerResponse.json(
          yield* increment(url.searchParams.get("command") ?? undefined),
        );
      case "again": {
        const first = yield* increment(`again-${id}`);
        const second = yield* increment(`again-${id}`);
        return yield* HttpServerResponse.json({ first, second });
      }
      case "give": {
        const commandId = url.searchParams.get("id");
        return yield* HttpServerResponse.json(
          yield* giving
            .send(
              new Give({ from: id, to: url.searchParams.get("to") ?? "", by }),
              commandId === null ? {} : { commandId },
            )
            .pipe(
              Effect.map((receipt) => ({
                accepted: receipt.reply.total,
                commits: receipt.commits,
              })),
              Effect.catchTag("Short", (rejection) => Effect.succeed({ rejected: rejection._tag })),
            ),
        );
      }
      case "import": {
        const n = Number(url.searchParams.get("n") ?? "1");
        const at = url.searchParams.get("at");
        const options = {
          commandId: url.searchParams.get("id") ?? `import:${id}`,
          expectedVersion: Number(url.searchParams.get("expected") ?? "0"),
        };
        const step = Number(url.searchParams.get("step") ?? "1");
        const stamped = <E>(event: E, i: number) =>
          at === null ? event : { event, at: DateTime.makeUnsafe(Number(at) + i * step) };
        const imported: Effect.Effect<
          { readonly version: number },
          UnexpectedVersion | ImportOutOfOrder
        > =
          url.searchParams.get("on") === "echo"
            ? echoes.import(
                Echo.ref(id),
                Array.from({ length: n }, (_, i) => stamped(new Mirrored({ by: 1 }), i)),
                options,
              )
            : counters.import(
                Counter.ref(id),
                Array.from({ length: n }, (_, i) => stamped(new Incremented({ by: 1 }), i)),
                options,
              );
        return yield* HttpServerResponse.json(
          yield* imported.pipe(
            Effect.map((receipt) => ({ version: receipt.version })),
            Effect.catchTag("UnexpectedVersion", (refused) =>
              Effect.succeed({ rejected: refused._tag, version: refused.version }),
            ),
            Effect.catchTag("ImportOutOfOrder", (refused) =>
              Effect.succeed({ rejected: refused._tag, index: refused.index }),
            ),
          ),
        );
      }
      case "times": {
        const read = yield* times.get(Counter.ref(id)).pipe(Effect.orDie);
        return yield* HttpServerResponse.json(
          Option.getOrElse(read, () => ({ first: 0, last: 0 })),
        );
      }
      case "counter":
        return yield* HttpServerResponse.json(yield* counters.get(id));
      case "echo":
        return yield* HttpServerResponse.json(yield* echoes.get(id));
      case "total": {
        const total = yield* totals.get(Counter.ref(id)).pipe(Effect.orDie);
        return yield* HttpServerResponse.json(
          Option.getOrElse(total, () => ({ total: 0, increments: 0 })),
        );
      }
      case "totals": {
        const order = url.searchParams.get("order");
        const take = url.searchParams.get("take");
        const after = url.searchParams.get("after");
        const page = yield* totals.list(Counter.ref(id), {
          ...(order === "asc" || order === "desc" ? { order } : {}),
          ...(take === null ? {} : { take: Number(take) }),
          ...(after === null ? {} : { after: Number(after) }),
        });
        return yield* HttpServerResponse.json({
          totals: page.entries.map((entry) => entry.state?.total ?? null),
          cursor: page.cursor,
        });
      }
      case "hidden": {
        const version = Number(url.searchParams.get("version") ?? "1");
        const total = yield* hidden
          .get(Counter.ref(id), { atLeast: { stream: `Counter/${id}`, version } })
          .pipe(Effect.orDie);
        return yield* HttpServerResponse.json(Option.getOrElse(total, () => ({ total: 0 })));
      }
      case "record": {
        const receipt = yield* counters.send(new Increment({ id, by })).pipe(Effect.orDie);
        // Read straight after caughtUp, without polling: the projection is fed by the view.
        yield* progress.caughtUp(receipt, { timeout: "60 seconds" }).pipe(Effect.orDie);
        const { entries } = yield* recorded.list(Counter.ref(id));
        return yield* HttpServerResponse.json(entries.map((entry) => entry.event.total));
      }
      case "tally": {
        const receipt = yield* counters.send(new Increment({ id, by })).pipe(Effect.orDie);
        // A rebuild's first input to a key waits for its catch-up run: allow minutes.
        yield* internals.caughtUp.get("Tallies")!(receipt, { timeout: "5 minutes" }).pipe(
          Effect.orDie,
        );
        const { entries } = yield* tallies.list(tallyKey(id) ?? id);
        return yield* HttpServerResponse.json(entries.map((entry) => entry.event.by));
      }
      case "generation":
        return yield* HttpServerResponse.json(
          internals.kernel.generationOf("projection", "TallyWriter"),
        );
      case "place":
        yield* holds.send(new PlaceHold({ id }));
        return yield* HttpServerResponse.json(yield* holds.get(id));
      case "release":
        yield* holds.send(new ReleaseHold({ id }));
        return yield* HttpServerResponse.json(yield* holds.get(id));
      case "hold":
        return yield* HttpServerResponse.json(yield* holds.get(id));
      default:
        return HttpServerResponse.text("Not Found", { status: 404 });
    }
  });
});
