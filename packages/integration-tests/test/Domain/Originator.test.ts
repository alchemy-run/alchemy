import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import * as InMemoryPlatform from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import {
  Account,
  AccountId,
  Balance,
  Deposit,
  Deposited,
  Transfer,
  TransferMoney,
  TransferReceived,
  TransferSent,
} from "./decision-model.ts";
import { simHost } from "./sim-host.ts";

const a = AccountId.make("a");
const b = AccountId.make("b");

/** What a policy saw of each event: its tag, and the envelope's originator (`"-"` when it has none). */
class Seen extends Context.Service<
  Seen,
  {
    readonly note: (source: string, event: string, envelope: object) => Effect.Effect<void>;
    readonly all: Effect.Effect<ReadonlyArray<string>>;
  }
>()("Test/Originator/Seen") {
  static readonly memory = Layer.effect(
    Seen,
    Effect.map(Ref.make<ReadonlyArray<string>>([]), (log) => ({
      note: (source, event, envelope) =>
        Ref.update(log, (all) => [
          ...all,
          `${source} ${event} ${"originator" in envelope ? JSON.stringify(envelope.originator) : "-"}`,
        ]),
      all: Ref.get(log),
    })),
  );
}

/** Hears the aggregate's own events. */
class HearsAccount extends Domain.Policy("HearsAccount", {
  from: Account,
  on: [Deposited, TransferSent, TransferReceived],
}) {}
const HearsAccountLive = HearsAccount.toLayer(
  Effect.gen(function* () {
    const seen = yield* Seen;
    return Effect.fn(function* ({ event, envelope }) {
      yield* seen.note("account", event._tag, envelope);
    });
  }),
);

/** Hears them again through the view, which passes each event on in its own envelope. */
class HearsBalance extends Domain.Policy("HearsBalance", {
  from: Balance,
  on: [Deposited],
}) {}
const HearsBalanceLive = HearsBalance.toLayer(
  Effect.gen(function* () {
    const seen = yield* Seen;
    return Effect.fn(function* ({ event, envelope }) {
      yield* seen.note("view", event._tag, envelope);
    });
  }),
);

class Audited extends Domain.Model("Audited", {
  aggregates: [Account],
  decisions: [Transfer],
  views: [Balance],
  policies: [HearsAccount, HearsBalance],
}) {}

/** The model on `platform`'s layer, and a way to wait until what it queued has been delivered. */
const audited = (
  platform: Layer.Layer<Domain.Platform | SecureRandom.SecureRandom, never, never>,
) =>
  Audited.layer(Layer.mergeAll(HearsAccountLive, HearsBalanceLive)).pipe(
    Layer.provideMerge(Layer.mergeAll(platform, Seen.memory)),
  );

/** Wait until the policies have heard `count` events: Durable Objects deliver in the background. */
const heard = (count: number) =>
  Effect.gen(function* () {
    const seen = yield* Seen;
    yield* seen.all.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        until: (all) => all.length >= count,
        times: 500,
      }),
    );
    return [...(yield* seen.all)].sort();
  });

const platforms: ReadonlyArray<
  readonly [
    name: string,
    host: () => {
      readonly layer: Layer.Layer<Domain.Platform | SecureRandom.SecureRandom>;
      /** Deliver what is queued, where the platform waits to be told to. */
      readonly settle: Effect.Effect<void>;
    },
  ]
> = [
  [
    "Durable Objects",
    () => ({
      layer: DurableObjects.makePlatform(simHost({ rowsRead: 0 }).host).pipe(
        Layer.provideMerge(SecureRandom.layerWebCrypto),
      ),
      settle: Effect.void,
    }),
  ],
  [
    "the in-memory platform",
    () => {
      const platform = InMemoryPlatform.make({ manual: true });
      return {
        layer: platform.layer.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto)),
        settle: Effect.gen(function* () {
          while (true) {
            yield* platform.control.drain;
            if (yield* platform.control.idle) return;
            yield* Effect.sleep("1 millis");
          }
        }),
      };
    },
  ],
];

for (const [name, host] of platforms) {
  describe(`Domain originator, on ${name}`, { tags: ["unit", "local"] }, () => {
    it.live("a command sent with an originator commits events that carry it", () => {
      const { layer, settle } = host();
      return Effect.gen(function* () {
        const accounts = yield* Account;
        yield* accounts
          .send(new Deposit({ accountId: a, amount: 5 }))
          .pipe(Effect.provideService(Domain.Originator, { actor: "sam" }));
        yield* settle;
        // the policy reads the aggregate's envelope; the view passes it on unchanged
        expect(yield* heard(2)).toEqual([
          'account Deposited {"actor":"sam"}',
          'view Deposited {"actor":"sam"}',
        ]);
      }).pipe(Effect.provide(audited(layer)));
    });

    it.live("a command sent without one commits events with none", () => {
      const { layer, settle } = host();
      return Effect.gen(function* () {
        const accounts = yield* Account;
        yield* accounts.send(new Deposit({ accountId: a, amount: 5 }));
        yield* settle;
        expect(yield* heard(2)).toEqual(["account Deposited -", "view Deposited -"]);
      }).pipe(Effect.provide(audited(layer)));
    });

    it.live("a decision records the originator on every instance it writes", () => {
      const { layer, settle } = host();
      return Effect.gen(function* () {
        const accounts = yield* Account;
        const transfer = yield* Transfer;
        yield* accounts.send(new Deposit({ accountId: a, amount: 100 }));
        yield* transfer
          .send(new TransferMoney({ from: a, to: b, amount: 30 }))
          .pipe(Effect.provideService(Domain.Originator, ["alex", 7]));
        yield* settle;
        expect(yield* heard(4)).toEqual([
          "account Deposited -",
          'account TransferReceived ["alex",7]',
          'account TransferSent ["alex",7]',
          "view Deposited -",
        ]);
      }).pipe(Effect.provide(audited(layer)));
    });
  });
}
