import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Account, Before, Deposit } from "./ledger.ts";

const LedgerLive = Before.layer(Layer.empty).pipe(Layer.provide(DomainCloudflare.DurableObjects));

/** `POST /deposit/<account>/<amount>` and `GET /version`, on the model without the view. */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const accounts = yield* Account;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname.split("/");
        if (path[1] === "version") return HttpServerResponse.text("v1");
        if (path[1] !== "deposit") return HttpServerResponse.text("Not Found", { status: 404 });
        yield* accounts.send(path[2]!, new Deposit({ amount: Number(path[3]) }));
        return yield* HttpServerResponse.json(yield* accounts.state(path[2]!));
      }),
    };
  }).pipe(Effect.provide(LedgerLive)),
) {}
