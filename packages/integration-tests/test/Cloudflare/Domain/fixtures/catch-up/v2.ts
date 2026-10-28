import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Account, After, Deposit, Deposits } from "./ledger.ts";

const LedgerLive = After.layer(Layer.empty).pipe(Layer.provide(DomainCloudflare.DurableObjects));

/**
 * The same Worker, redeployed with the view: `POST /deposit/<account>/<amount>`,
 * `GET /deposits/<account>` and `GET /version`.
 */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const accounts = yield* Account;
    const deposits = yield* Deposits;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname.split("/");
        if (path[1] === "version") return HttpServerResponse.text("v2");
        if (path[1] === "deposits") {
          const state = yield* deposits.query(Account.ref(path[2]!));
          return yield* HttpServerResponse.json(Option.getOrNull(state));
        }
        if (path[1] !== "deposit") return HttpServerResponse.text("Not Found", { status: 404 });
        yield* accounts.send(path[2]!, new Deposit({ amount: Number(path[3]) }));
        return yield* HttpServerResponse.json(yield* accounts.state(path[2]!));
      }).pipe(
        Effect.catchTag("ConsistencyTimeout", () =>
          Effect.succeed(HttpServerResponse.text("not caught up", { status: 503 })),
        ),
      ),
    };
  }).pipe(Effect.provide(LedgerLive)),
) {}
