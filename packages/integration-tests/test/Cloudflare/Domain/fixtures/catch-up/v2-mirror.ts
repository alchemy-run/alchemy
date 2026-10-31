import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Account, Deposit, Journal, Mirror, Mirrored, Note } from "./ledger.ts";
import { hosted } from "./worker.ts";

/** The policy notes each deposit, marking the ones it replayed from the history. */
const MirrorLive = Mirror.toLayer(
  { replay: true },
  Effect.gen(function* () {
    const journals = yield* Journal;
    return Effect.fn(function* ({ source, event, history }) {
      yield* journals
        .send(`j-${source.id}`, new Note({ note: `${history ? "past" : "new"} ${event.amount}` }))
        .pipe(Effect.orDie);
    });
  }),
);

/**
 * The second deploy adds the policy: `POST /deposit/<account>/<amount>`,
 * `GET /journal/<account>` and `GET /version`.
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
        if (path[1] === "version") return HttpServerResponse.text("v2-mirror");
        if (path[1] === "journal")
          return yield* HttpServerResponse.json(yield* journals.state(`j-${path[2]!}`));
        if (path[1] !== "deposit") return HttpServerResponse.text("Not Found", { status: 404 });
        yield* accounts.send(path[2]!, new Deposit({ amount: Number(path[3]) }));
        return yield* HttpServerResponse.json(yield* accounts.state(path[2]!));
      }),
    };
  }).pipe(Effect.provide(hosted(Mirrored.layer(MirrorLive)))),
) {}
