import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import * as InMemoryPlatform from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

/** What a policy saw of each event: its tag, and the envelope's metadata (`"-"` when it has none). */
class Seen extends Context.Service<
  Seen,
  {
    readonly note: (source: string, event: string, envelope: object) => Effect.Effect<void>;
    readonly all: Effect.Effect<ReadonlyArray<string>>;
  }
>()("Test/CommitHook/Seen") {
  static readonly memory = Layer.effect(
    Seen,
    Effect.map(Ref.make<ReadonlyArray<string>>([]), (log) => ({
      note: (source, event, envelope) =>
        Ref.update(log, (all) => [
          ...all,
          `${source} ${event} ${"metadata" in envelope ? JSON.stringify(envelope.metadata) : "-"}`,
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

/** What the hook was asked, in the order it was asked. */
type Call = {
  readonly aggregate: string;
  readonly id: string;
  readonly stream: string;
  readonly version: number;
  readonly command: string;
  readonly events: ReadonlyArray<string>;
};

/** The model with `hook` in the Layer it is built in, and a record of the hook's calls. */
const hooked = (
  platform: Layer.Layer<Domain.Platform | SecureRandom.SecureRandom>,
  hook: (
    input: Domain.Aggregate.CommitHookInput,
  ) => Effect.Effect<Record<string, unknown> | undefined, Domain.CommitRefused> | undefined,
) => {
  const calls: Array<Call> = [];
  const layer = Layer.succeed(Domain.CommitHook, {
    commit: (input) => {
      calls.push({
        aggregate: input.aggregate,
        id: input.id,
        stream: input.stream,
        version: input.version,
        command: input.command,
        events: input.events.map((event) => event._tag),
      });
      return hook(input) ?? Effect.succeed(undefined);
    },
  });
  return {
    calls,
    layer: Audited.layer(Layer.mergeAll(HearsAccountLive, HearsBalanceLive)).pipe(
      Layer.provide(layer),
      Layer.provideMerge(Layer.mergeAll(platform, Seen.memory)),
    ),
  };
};

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

/** The defect a failed send died with. */
const defectOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

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
  describe(`Domain commit hook, on ${name}`, { tags: ["unit", "local"] }, () => {
    it.live("what the hook returns is on the envelope of every event the command commits", () => {
      const { layer: platform, settle } = host();
      const { calls, layer } = hooked(platform, (input) =>
        Effect.succeed({ label: input.aggregate, by: input.context["Domain/Originator"] }),
      );
      return Effect.gen(function* () {
        const accounts = yield* Account;
        yield* accounts
          .send(new Deposit({ accountId: a, amount: 5 }))
          .pipe(Effect.provideService(Domain.Originator, { actor: "sam" }));
        yield* settle;
        const metadata = '{"label":"Account","by":{"actor":"sam"}}';
        // the policy reads the aggregate's envelope; the view passes it on unchanged
        expect(yield* heard(2)).toEqual([
          `account Deposited ${metadata}`,
          `view Deposited ${metadata}`,
        ]);
        expect(calls).toEqual([
          {
            aggregate: "Account",
            id: "a",
            stream: "Account/a",
            version: 0,
            command: "Deposit",
            events: ["Deposited"],
          },
        ]);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "a decision asks the hook once for each instance it writes, and each keeps its own",
      () => {
        const { layer: platform, settle } = host();
        const { calls, layer } = hooked(platform, (input) => Effect.succeed({ on: input.id }));
        return Effect.gen(function* () {
          const accounts = yield* Account;
          const transfer = yield* Transfer;
          yield* accounts.send(new Deposit({ accountId: a, amount: 100 }));
          yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
          yield* settle;
          expect(yield* heard(4)).toEqual([
            'account Deposited {"on":"a"}',
            'account TransferReceived {"on":"b"}',
            'account TransferSent {"on":"a"}',
            'view Deposited {"on":"a"}',
          ]);
          expect(calls.slice(1)).toEqual([
            {
              aggregate: "Account",
              id: "a",
              stream: "Account/a",
              version: 1,
              command: "TransferMoney",
              events: ["TransferSent"],
            },
            {
              aggregate: "Account",
              id: "b",
              stream: "Account/b",
              version: 0,
              command: "TransferMoney",
              events: ["TransferReceived"],
            },
          ]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("a refused command dies with CommitRefused and stores nothing", () => {
      const { layer: platform, settle } = host();
      const { layer } = hooked(platform, (input) =>
        input.context["Domain/Originator"] === undefined
          ? Effect.fail(
              new Domain.CommitRefused({
                aggregate: input.aggregate,
                id: input.id,
                reason: "no originator",
              }),
            )
          : undefined,
      );
      return Effect.gen(function* () {
        const accounts = yield* Account;
        const refused = defectOf(
          yield* Effect.exit(accounts.send(new Deposit({ accountId: a, amount: 5 }))),
        );
        expect(Domain.isCommitRefused(refused)).toBe(true);
        expect(refused).toMatchObject({ aggregate: "Account", id: "a", reason: "no originator" });
        expect(yield* accounts.get(a)).toEqual({ balance: 0 });
        // the same command goes through once it comes with what the hook wants
        yield* accounts
          .send(new Deposit({ accountId: a, amount: 5 }))
          .pipe(Effect.provideService(Domain.Originator, "sam"));
        yield* settle;
        expect(yield* accounts.get(a)).toEqual({ balance: 5 });
        expect(yield* heard(2)).toEqual(["account Deposited -", "view Deposited -"]);
      }).pipe(Effect.provide(layer));
    });

    it.live("a decision a hook refuses on one instance stores nothing on any", () => {
      const { layer: platform, settle } = host();
      const { layer } = hooked(platform, (input) =>
        input.id === "b" && input.command === "TransferMoney"
          ? Effect.fail(
              new Domain.CommitRefused({
                aggregate: input.aggregate,
                id: input.id,
                reason: "frozen",
              }),
            )
          : undefined,
      );
      return Effect.gen(function* () {
        const accounts = yield* Account;
        const transfer = yield* Transfer;
        yield* accounts.send(new Deposit({ accountId: a, amount: 100 }));
        const refused = defectOf(
          yield* Effect.exit(transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }))),
        );
        expect(Domain.isCommitRefused(refused)).toBe(true);
        expect(yield* accounts.get(a)).toEqual({ balance: 100 });
        expect(yield* accounts.get(b)).toEqual({ balance: 0 });
        yield* settle;
        expect(yield* heard(2)).toEqual(["account Deposited -", "view Deposited -"]);
      }).pipe(Effect.provide(layer));
    });

    it.live("a hook a sender provides is not the host's, and with none, events carry none", () => {
      const { layer: platform, settle } = host();
      const { calls, layer } = hooked(platform, () => Effect.succeed({ from: "host" }));
      return Effect.gen(function* () {
        const accounts = yield* Account;
        yield* accounts.send(new Deposit({ accountId: a, amount: 5 })).pipe(
          Effect.provideService(Domain.CommitHook, {
            commit: ({ aggregate, id }) =>
              Effect.fail(new Domain.CommitRefused({ aggregate, id, reason: "sender's" })),
          }),
        );
        yield* settle;
        expect(yield* heard(2)).toEqual([
          'account Deposited {"from":"host"}',
          'view Deposited {"from":"host"}',
        ]);
        expect(calls).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    });
  });
}
