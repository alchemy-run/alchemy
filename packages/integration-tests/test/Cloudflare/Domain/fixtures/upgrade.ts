import * as Domain from "@alchemy.run/domain";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { DeployVersion } from "@alchemy.run/domain/Cloudflare/Version";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Activity, DurableDeferred } from "effect/workflow";
import { Account, Open, Owners } from "./isolation.ts";

/** The approval a run of {@link Approve} waits for. */
export const Approval = DurableDeferred.make("approval", { success: Schema.String });

/** Opens the account once someone approves it. */
export class Approve extends Domain.Saga("Approve", {
  key: Schema.String,
  input: { owner: Schema.String },
}) {}
export const ApproveLive = Approve.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ key, owner }) {
      const approvedBy = yield* DurableDeferred.await(Approval);
      yield* Activity.make({
        name: "open",
        execute: accounts
          .send(new Open({ id: key, owner: `${owner}:${approvedBy}` }))
          .pipe(Effect.asVoid),
      });
    });
  }),
);

export class Billing extends Domain.Model("Billing", {
  aggregates: [Account],
  views: [Owners],
  sagas: [Approve],
}) {}
export class Audit extends Domain.Model("Audit", { aggregates: [Account], views: [Owners] }) {}

/**
 * `POST /<model>/open/<id>/<owner>`, `POST /<model>/later/<id>/<owner>` (opens it in an
 * hour), `POST /<model>/cancel/<id>` (cancels that), `GET /<model>/state/<id>`,
 * `GET /<model>/owners/<id>`, `POST /saga/<key>/<owner>` (starts a run),
 * `GET /saga/<key>` (its status), `POST /approve/<key>/<by>` and
 * `GET /version`.
 */
const ROUTE = /^\/(Billing|Audit)\/(open|later|cancel|state|owners)\/([^/]+)(?:\/([^/]+))?$/;
const SAGA = /^\/(saga|approve)\/([^/]+)(?:\/([^/]+))?$/;

/**
 * A Worker hosting Billing, and Audit when `audit` is set, laid out as Domain
 * version `version` lays them out: `undefined` for the layout from before
 * versions existed. `legacyData` names the model that keeps a class the two
 * shared; the other sets `legacyData: false`. Unset, both take it over.
 */
export const upgradeWorker = ({
  version,
  audit,
  legacyData,
}: {
  readonly version: number | undefined;
  readonly audit: boolean;
  readonly legacyData?: "Billing" | "Audit";
}) =>
  Effect.gen(function* () {
    const Platform = DomainCloudflare.layerDurableObjects();
    const billing = yield* Effect.all({ accounts: Account, owners: Owners, runs: Approve }).pipe(
      Effect.provide(
        Billing.layer(ApproveLive, legacyData === "Audit" ? { legacyData: false } : {}).pipe(
          Layer.provide(Platform),
        ),
      ),
    );
    const models = {
      Billing: billing,
      Audit: audit
        ? yield* Effect.all({ accounts: Account, owners: Owners }).pipe(
            Effect.provide(
              Audit.layer(Layer.empty, legacyData === "Billing" ? { legacyData: false } : {}).pipe(
                Layer.provide(Platform),
              ),
            ),
          )
        : undefined,
    };
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/version")
          return yield* HttpServerResponse.json({ version: version ?? null });
        const saga = SAGA.exec(path);
        if (saga) {
          const key = decodeURIComponent(saga[2]!);
          if (saga[1] === "approve") {
            yield* billing.runs.get(key).signal(Approval, saga[3]!);
            return yield* HttpServerResponse.json({ approved: true });
          }
          if (request.method === "POST") {
            yield* billing.runs.start(key, { owner: saga[3]! });
            return yield* HttpServerResponse.json({ started: true });
          }
          return yield* HttpServerResponse.json(yield* billing.runs.get(key).status);
        }
        const route = ROUTE.exec(path);
        const model = route ? models[route[1] as "Billing" | "Audit"] : undefined;
        if (!route || !model) return HttpServerResponse.text("Not Found", { status: 404 });
        const id = decodeURIComponent(route[3]!);
        if (route[2] === "open") {
          const receipt = yield* model.accounts.send(new Open({ id, owner: route[4]! }));
          return yield* HttpServerResponse.json({ version: receipt.version });
        }
        // Open the account in an hour: until then it has only a scheduled command.
        if (route[2] === "later") {
          const receipt = yield* model.accounts.schedule(new Open({ id, owner: route[4]! }), {
            after: "1 hour",
            commandId: "open-later",
          });
          return yield* HttpServerResponse.json({ at: DateTime.toEpochMillis(receipt.at) });
        }
        // Cancel it: `Cancelled` when the command was still scheduled.
        if (route[2] === "cancel")
          return yield* HttpServerResponse.json({
            cancel: yield* model.accounts.unschedule(id, "open-later").pipe(
              Effect.as("Cancelled"),
              Effect.catchTag(["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"], (e) =>
                Effect.succeed(e._tag),
              ),
            ),
          });
        if (route[2] === "owners")
          return yield* HttpServerResponse.json(
            Option.getOrNull(yield* model.owners.get(Account.ref(id)).pipe(Effect.orDie)),
          );
        return yield* HttpServerResponse.json(yield* model.accounts.get(id));
      }).pipe(
        // Answer a failure with its cause, so a failed test shows why.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provideService(DeployVersion, version));
