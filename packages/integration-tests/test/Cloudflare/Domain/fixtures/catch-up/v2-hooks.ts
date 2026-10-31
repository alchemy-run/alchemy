import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Account, Deposit, Hooked, Journal, Ledger, Note } from "./ledger.ts";
import { hosted } from "./worker.ts";

/** The projection writes its hooks and each input to the `hooks` journal, as a store would. */
const LedgerLive = Ledger.toLayer(
  Effect.gen(function* () {
    const journals = yield* Journal;
    const note = (text: string) =>
      journals.send("hooks", new Note({ note: text })).pipe(Effect.orDie);
    return {
      handle: Effect.fn(function* (batch) {
        for (const { key, event, generation } of batch)
          yield* note(`g${generation} ${key.id}:${event.amount}`);
      }),
      start: ({ generation, previous }) => note(`start g${generation} after ${previous ?? "none"}`),
      complete: ({ generation, previous }) =>
        note(`complete g${generation} after ${previous ?? "none"}`),
    };
  }),
);

/**
 * The second deploy adds the projection: `POST /deposit/<account>/<amount>`,
 * `GET /hooks` and `GET /version`.
 */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const accounts = yield* Account;
    const journals = yield* Journal;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname.split("/");
        if (path[1] === "version") return HttpServerResponse.text("v2-hooks");
        if (path[1] === "hooks")
          return yield* HttpServerResponse.json(yield* journals.state("hooks"));
        if (path[1] !== "deposit") return HttpServerResponse.text("Not Found", { status: 404 });
        yield* accounts.send(path[2]!, new Deposit({ amount: Number(path[3]) }));
        return yield* HttpServerResponse.json(yield* accounts.state(path[2]!));
      }),
    };
  }).pipe(Effect.provide(hosted(Hooked.layer(LedgerLive)))),
) {}
