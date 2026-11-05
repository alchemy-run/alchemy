import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { DeployVersion } from "@alchemy.run/cloudflare/Domain/Version";
import * as Domain from "@alchemy.run/domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** How many models the Worker hosts, as in the report of #2976. */
export const MODELS = 8;

/**
 * One model's definitions, named after it, so no two models share a class:
 * two aggregates and a view of each, six classes before Domain versions.
 */
const definitions = (n: number) => {
  class Opened extends Domain.Event(`Opened${n}`, { owner: Schema.String }) {}
  class Open extends Domain.Command(`Open${n}`, {
    target: Schema.String,
    input: { owner: Schema.String },
    events: [Opened],
  }) {}
  const account = (name: string) =>
    Domain.Aggregate(name, {
      id: Schema.String,
      state: Schema.Struct({ owner: Schema.NullOr(Schema.String) }),
      initial: { owner: null },
      commands: [Open],
      decide: {
        [`Open${n}`]: (_: unknown, { owner }: { owner: string }) => [new Opened({ owner })],
      },
      evolve: { [`Opened${n}`]: (_: unknown, { owner }: { owner: string }) => ({ owner }) },
    } as never);
  class Checking extends account(`Checking${n}`) {}
  class Savings extends account(`Savings${n}`) {}
  const owners = (name: string, from: typeof Checking) =>
    Domain.View(name, {
      from: [from],
      key: from,
      state: Schema.Struct({ owner: Schema.String }),
      initial: { owner: "" },
      evolve: { [`Opened${n}`]: (_: unknown, { owner }: { owner: string }) => ({ owner }) },
    } as never);
  class CheckingOwners extends owners(`CheckingOwners${n}`, Checking) {}
  class SavingsOwners extends owners(`SavingsOwners${n}`, Savings) {}
  class Bank extends Domain.Model(`Bank${n}`, {
    aggregates: [Checking, Savings],
    views: [CheckingOwners, SavingsOwners],
  } as never) {}
  return { Open, Checking, Savings, CheckingOwners, SavingsOwners, Bank };
};

/** Every model's definitions, made once. */
const banks = Array.from({ length: MODELS }, (_, n) => definitions(n));

/** `POST /<n>/<checking|savings>/open/<id>/<owner>`, `GET /<n>/<checking|savings>/<state|owners>/<id>`, `GET /version`. */
const ROUTE = /^\/(\d+)\/(checking|savings)\/(open|state|owners)\/([^/]+)(?:\/([^/]+))?$/;

/**
 * A Worker hosting {@link MODELS} models laid out as Domain version `version`
 * lays them out: `undefined` for the layout from before versions existed. They
 * all had a `DomainDirectory` class before versions; the first model keeps it.
 */
export const scaleWorker = (version: number | undefined) =>
  Effect.gen(function* () {
    const Platform = DomainCloudflare.layerDurableObjects();
    const hosted = yield* Effect.forEach(
      banks,
      (bank, n) =>
        Effect.all({
          checking: bank.Checking as any,
          savings: bank.Savings as any,
          checkingOwners: bank.CheckingOwners as any,
          savingsOwners: bank.SavingsOwners as any,
        }).pipe(
          Effect.provide(
            (bank.Bank as any)
              .layer(Layer.empty, { legacyData: n === 0 })
              .pipe(Layer.provide(Platform)) as Layer.Layer<never>,
          ),
        ) as unknown as Effect.Effect<Record<string, any>>,
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/version")
          return yield* HttpServerResponse.json({ version: version ?? null });
        const route = ROUTE.exec(path);
        const n = route ? Number(route[1]) : -1;
        const model = hosted[n] as any;
        if (!route || model === undefined)
          return HttpServerResponse.text("Not Found", { status: 404 });
        const bank = banks[n]!;
        const id = decodeURIComponent(route[4]!);
        const checking = route[2] === "checking";
        const accounts = checking ? model.checking : model.savings;
        if (route[3] === "open") {
          const receipt = yield* accounts.send(id, new bank.Open({ owner: route[5]! } as never));
          return yield* HttpServerResponse.json({ version: receipt.version });
        }
        if (route[3] === "owners") {
          const owners = checking ? model.checkingOwners : model.savingsOwners;
          const ref = ((checking ? bank.Checking : bank.Savings) as any).ref(id);
          return yield* HttpServerResponse.json(
            Option.getOrNull(yield* owners.query(ref).pipe(Effect.orDie)),
          );
        }
        return yield* HttpServerResponse.json(yield* accounts.state(id));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ) as Effect.Effect<HttpServerResponse.HttpServerResponse>,
    };
  }).pipe(Effect.provideService(DeployVersion, version));
