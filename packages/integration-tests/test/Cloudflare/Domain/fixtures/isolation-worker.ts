import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  Account,
  Audit,
  Billing,
  Open,
  OpenAccount,
  OpenAccountLive,
  Owners,
  Sales,
  Support,
} from "./isolation.ts";

/** Billing's and Audit's Account and Owners, hosted on one platform. */
const clients = (platform: ReturnType<typeof DomainCloudflare.layerDurableObjects>) =>
  Effect.all({
    Billing: Effect.all({ accounts: Account, owners: Owners }).pipe(
      Effect.provide(Billing.layer(Layer.empty).pipe(Layer.provide(platform))),
    ),
    Audit: Effect.all({ accounts: Account, owners: Owners }).pipe(
      Effect.provide(Audit.layer(Layer.empty).pipe(Layer.provide(platform))),
    ),
  });

/** Sales' and Support's Account and OpenAccount runs, on the default platform. */
const sagas = Effect.all({
  Sales: Effect.all({ accounts: Account, runs: OpenAccount }).pipe(
    Effect.provide(
      Sales.layer(OpenAccountLive).pipe(Layer.provide(DomainCloudflare.layerDurableObjects())),
    ),
  ),
  Support: Effect.all({ accounts: Account, runs: OpenAccount }).pipe(
    Effect.provide(
      Support.layer(OpenAccountLive).pipe(Layer.provide(DomainCloudflare.layerDurableObjects())),
    ),
  ),
});

/** `POST /saga/<model>/<key>/<owner>` runs OpenAccount to the end and answers the model's Account. */
const SAGA_ROUTE = /^\/saga\/(Sales|Support)\/([^/]+)\/([^/]+)$/;

/**
 * `POST /<isolate>/<model>/open/<id>/<owner>`, `GET /<isolate>/<model>/state/<id>`
 * and `GET /<isolate>/<model>/owners/<id>`, where `<isolate>` is `class` or
 * `key` and `<model>` is `Billing` or `Audit`.
 */
const ROUTE = /^\/(class|key)\/(Billing|Audit)\/(open|state|owners)\/([^/]+)(?:\/([^/]+))?$/;

export default class DomainIsolationWorker extends Cloudflare.Worker<DomainIsolationWorker>()(
  "DomainIsolationWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hosted = {
      class: yield* clients(DomainCloudflare.layerDurableObjects()),
      key: yield* clients(DomainCloudflare.layerDurableObjects({ isolate: "key" })),
    };
    const runs = yield* sagas;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        const saga = SAGA_ROUTE.exec(path);
        if (saga) {
          const { accounts, runs: openAccount } = runs[saga[1] as "Sales" | "Support"];
          const key = decodeURIComponent(saga[2]!);
          const run = yield* openAccount.start(key, { owner: saga[3]! });
          yield* run.result;
          return yield* HttpServerResponse.json(yield* accounts.state(key));
        }
        const route = ROUTE.exec(path);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const isolate = route[1] as "class" | "key";
        const { accounts, owners } = hosted[isolate][route[2] as "Billing" | "Audit"];
        const id = decodeURIComponent(route[4]!);
        if (route[3] === "open") {
          const receipt = yield* accounts.send(id, new Open({ owner: route[5]! }));
          return yield* HttpServerResponse.json({ version: receipt.version });
        }
        if (route[3] === "owners")
          return yield* HttpServerResponse.json(
            Option.getOrNull(yield* owners.query(Account.ref(id)).pipe(Effect.orDie)),
          );
        return yield* HttpServerResponse.json(yield* accounts.state(id));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
