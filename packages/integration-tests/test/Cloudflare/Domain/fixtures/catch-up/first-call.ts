/**
 * The ledger with many views, every Durable Object created in Asia-Pacific: a
 * caller elsewhere reaches a front near it, whose objects are far away. Each
 * view's run has a root object of its own, which the first Domain call in an
 * isolate tells about the model's plans.
 *
 * `GET /first` reads two new accounts one after the other and answers how long
 * each read took, and whether they were the isolate's first Domain calls.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Account } from "./ledger.ts";
import { hosted } from "./worker.ts";

/** How many views the model has: one run root each. */
export const VIEWS = 10;

const views = Array.from(
  { length: VIEWS },
  (_, i) =>
    class extends Domain.View(`Balance${i}`, {
      from: [Account],
      key: Account,
      state: Schema.Struct({ total: Schema.Number }),
      initial: { total: 0 },
      evolve: { Deposited: (s, e) => ({ total: s.total + e.amount }) },
    }) {},
);

class ManyViews extends Domain.Model("Ledger", { aggregates: [Account], views }) {}

/** Domain calls this isolate has served. */
let calls = 0;

export default class DomainFirstCallWorker extends Cloudflare.Worker<DomainFirstCallWorker>()(
  "DomainFirstCallWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const accounts = yield* Account;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/version") return HttpServerResponse.text("first-call");
        if (path !== "/first") return HttpServerResponse.text("Not Found", { status: 404 });
        const fresh = calls === 0;
        calls += 2;
        const nonce = crypto.randomUUID();
        // The clock moves on I/O, so each read's time includes the calls it made.
        const t0 = Date.now();
        yield* accounts.get(`first-${nonce}`);
        const t1 = Date.now();
        yield* accounts.get(`second-${nonce}`);
        const t2 = Date.now();
        return yield* HttpServerResponse.json({ fresh, first: t1 - t0, second: t2 - t1 });
      }),
    };
  }).pipe(Effect.provide(hosted(ManyViews.layer(Layer.empty), { locationHint: "apac" }))),
) {}
