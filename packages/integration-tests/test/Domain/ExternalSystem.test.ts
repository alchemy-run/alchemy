import * as Domain from "@alchemy.run/domain";
import * as ExternalSystem from "@alchemy.run/domain/ExternalSystem";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class RefundDeclined extends Domain.Rejection("RefundDeclined", { reason: Schema.String }) {}
class CardFrozen extends Domain.Rejection("CardFrozen") {}

class Payments extends Domain.ExternalSystem("Payments", {
  refund: {
    args: { settlementId: Schema.String, amount: Schema.Int },
    success: { refundId: Schema.String },
    error: RefundDeclined,
  },
  ping: {},
}) {}

/** An adapter whose answers the test picks, to break each side of the schema. */
const adapter = (answer: (args: { settlementId: string; amount: number }) => unknown) => {
  const seen: Array<unknown> = [];
  const layer = Payments.toLayer(
    Effect.succeed({
      refund: (args) => {
        seen.push(args);
        return answer(args) as never;
      },
      ping: () => Effect.succeed("pong" as unknown as void),
    }),
  );
  return { seen, layer };
};

const refund = (args: unknown) =>
  Effect.gen(function* () {
    const payments = yield* Payments;
    return yield* payments.refund(args as never);
  });

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("Domain ExternalSystem", () => {
  it.effect("passes valid arguments to the adapter and returns its answer", () =>
    Effect.gen(function* () {
      const { seen, layer } = adapter(({ settlementId }) =>
        Effect.succeed({ refundId: `re_${settlementId}` }),
      );
      const result = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.provide(layer),
      );
      expect(result).toEqual({ refundId: "re_st_1" });
      expect(seen).toEqual([{ settlementId: "st_1", amount: 500 }]);
    }),
  );

  it.effect("keeps a declared error a typed failure", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.fail(new RefundDeclined({ reason: "card-closed" })));
      const error = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      expect(error).toEqual(new RefundDeclined({ reason: "card-closed" }));
    }),
  );

  it.effect("arguments the schema rejects die before the adapter runs", () =>
    Effect.gen(function* () {
      const { seen, layer } = adapter(() => Effect.succeed({ refundId: "re_1" }));
      const exit = yield* refund({ settlementId: "st_1", amount: 1.5 }).pipe(
        Effect.exit,
        Effect.provide(layer),
      );
      const defect = defectOf(exit);
      expect(defect).toMatchObject({
        _tag: "ExternalSystemSchemaError",
        system: "Payments",
        op: "refund",
        part: "args",
      });
      expect(String((defect as Error).message)).toMatch(
        /^Payments\.refund was called with arguments its schema rejects\n.*amount/s,
      );
      expect(seen).toEqual([]);
    }),
  );

  it.effect("a value the success schema rejects dies", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.succeed({ refundId: 42 }));
      const exit = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.exit,
        Effect.provide(layer),
      );
      expect(defectOf(exit)).toMatchObject({ system: "Payments", op: "refund", part: "success" });
      expect(String((defectOf(exit) as Error).message)).toMatch(
        /^Payments\.refund returned a value its success schema rejects\n.*refundId/s,
      );
    }),
  );

  it.effect("an error the operation does not declare dies", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.fail(new CardFrozen()));
      const exit = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.exit,
        Effect.provide(layer),
      );
      expect(defectOf(exit)).toMatchObject({ system: "Payments", op: "refund", part: "error" });
      expect(String((defectOf(exit) as Error).message)).toMatch(
        /^Payments\.refund failed with an error its error schema rejects\n/,
      );
    }),
  );

  it.effect("keeps every error of a declared list a typed failure", () =>
    Effect.gen(function* () {
      class Cards extends Domain.ExternalSystem("Cards", {
        charge: { args: { amount: Schema.Int }, error: [RefundDeclined, CardFrozen] },
      }) {}
      const layer = Cards.toLayer(
        Effect.succeed({
          charge: ({ amount }) =>
            amount > 100
              ? Effect.fail(new CardFrozen())
              : Effect.fail(new RefundDeclined({ reason: "low" })),
        }),
      );
      const charge = (amount: number) =>
        Effect.gen(function* () {
          const cards = yield* Cards;
          return yield* cards.charge({ amount });
        }).pipe(Effect.flip, Effect.provide(layer));
      expect(yield* charge(500)).toEqual(new CardFrozen());
      expect(yield* charge(5)).toEqual(new RefundDeclined({ reason: "low" }));
    }),
  );

  it.effect("drops fields the success schema does not declare", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.succeed({ refundId: "re_1", raw: { vendor: "x" } }));
      const result = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.provide(layer),
      );
      expect(result).toEqual({ refundId: "re_1" });
    }),
  );

  it.effect("leaves the value of an operation without a success schema alone", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.succeed({ refundId: "re_1" }));
      const result = yield* Effect.gen(function* () {
        const payments = yield* Payments;
        return yield* payments.ping();
      }).pipe(Effect.provide(layer));
      expect(result).toBe("pong");
    }),
  );

  it.effect("validate: false skips every check", () =>
    Effect.gen(function* () {
      const layer = Payments.toLayer(
        Effect.succeed({
          refund: () => Effect.succeed({ refundId: 42 } as never),
          ping: () => Effect.void,
        }),
        { validate: false },
      );
      const result = yield* refund({ settlementId: "st_1", amount: 1.5 }).pipe(
        Effect.provide(layer),
      );
      expect(result).toEqual({ refundId: 42 });
    }),
  );
});

class Undeliverable extends Domain.Rejection("Undeliverable", { reason: Schema.String }) {}

class Sms extends Domain.ExternalSystem("Sms", {
  send: {
    args: { to: Schema.String, body: Schema.String },
    success: { messageId: Schema.String, segments: Schema.Int },
    error: Undeliverable,
  },
}) {}

class Email extends Domain.ExternalSystem("Email", {
  send: { args: { to: Schema.String } },
}) {}

// One contract every Sms adapter keeps.
const SmsContract = ExternalSystem.contract(Sms, {
  "sends a message": ExternalSystem.returns(Sms.send, { to: "+15550100", body: "hi" }),
  "counts the segments": ExternalSystem.returns(
    Sms.send,
    { to: "+15550100", body: "x".repeat(200) },
    { segments: 2 },
  ),
  "names the message": ExternalSystem.returns(
    Sms.send,
    { to: "+15550100", body: "hi" },
    ({ messageId }) => messageId.length > 0,
  ),
  "refuses a landline": ExternalSystem.fails(
    Sms.send,
    { to: "+15550199", body: "hi" },
    "Undeliverable",
  ),
  "says why it refuses": ExternalSystem.fails(
    Sms.send,
    { to: "+15550199", body: "hi" },
    { reason: "landline" },
  ),
});

// Cases are typed by their operation.
// @ts-expect-error `to` is a string
export const wrongArgs = ExternalSystem.returns(Sms.send, { to: 1, body: "hi" });
export const wrongTag = ExternalSystem.fails(
  Sms.send,
  { to: "+15550100", body: "hi" },
  // @ts-expect-error send declares no `Throttled` error
  "Throttled",
);
export const wrongValue = ExternalSystem.returns(
  Sms.send,
  { to: "+1", body: "hi" },
  // @ts-expect-error `segments` is a number
  { segments: "2" },
);

const answer = (to: string, body: string, id: string) =>
  to === "+15550199"
    ? Effect.fail(new Undeliverable({ reason: "landline" }))
    : Effect.succeed({ messageId: id, segments: Math.ceil(body.length / 160) });

// A vendor adapter and an in-memory fake, built differently, proving the same contract.
const TwilioSms = Sms.toLayer(
  Effect.succeed({ send: ({ to, body }) => answer(to, body, `SM${to.slice(-4)}`) }),
);
const FakeSms = Sms.toLayer(
  Effect.sync(() => {
    let next = 0;
    return { send: ({ to, body }) => answer(to, body, `fake-${++next}`) };
  }),
);

const adapters: ReadonlyArray<
  readonly [string, Layer.Layer<ExternalSystem.Identifier<typeof Sms>>]
> = [
  ["Twilio", TwilioSms],
  ["fake", FakeSms],
];

for (const [adapter, layer] of adapters) {
  describe(`Sms contract: ${adapter}`, () => {
    for (const [name, test] of Object.entries(SmsContract)) {
      it.effect(name, () => test.pipe(Effect.provide(layer)));
    }
  });
}

/** Run one case of the contract against an adapter whose answer the test picks. */
const runCase = (name: keyof typeof SmsContract, send: (args: any) => Effect.Effect<any, any>) =>
  SmsContract[name].pipe(Effect.flip, Effect.provide(Sms.toLayer(Effect.succeed({ send }))));

describe("Domain ExternalSystem.contract", () => {
  it.effect("a value the expectation does not match fails the case", () =>
    Effect.gen(function* () {
      const failure = yield* runCase("counts the segments", () =>
        Effect.succeed({ messageId: "m1", segments: 1 }),
      );
      expect(failure).toBeInstanceOf(ExternalSystem.ContractFailure);
      expect(failure).toMatchObject({ system: "Sms", op: "send", case: "counts the segments" });
      expect(failure.message).toBe(
        'Sms.send "counts the segments": expected a value matching {"segments":2}, got {"messageId":"m1","segments":1}',
      );
    }),
  );

  it.effect("a check that returns false fails the case", () =>
    Effect.gen(function* () {
      const failure = yield* runCase("names the message", () =>
        Effect.succeed({ messageId: "", segments: 1 }),
      );
      expect(failure.message).toBe(
        'Sms.send "names the message": the check rejected the value {"messageId":"","segments":1}',
      );
    }),
  );

  it.effect("a value the success schema rejects fails the case", () =>
    Effect.gen(function* () {
      const failure = yield* runCase("sends a message", () =>
        Effect.succeed({ messageId: "m1", segments: 1.5 }),
      );
      expect(failure.message).toMatch(
        /^Sms\.send "sends a message": returned a value its success schema rejects\n.*segments/s,
      );
    }),
  );

  it.effect("a failure where the case expects a value fails the case", () =>
    Effect.gen(function* () {
      const failure = yield* runCase("sends a message", () =>
        Effect.fail(new Undeliverable({ reason: "carrier down" })),
      );
      expect(failure.message).toBe(
        'Sms.send "sends a message": expected a value, but it failed with {"_tag":"Undeliverable","reason":"carrier down"}',
      );
    }),
  );

  it.effect("a value where the case expects a failure fails the case", () =>
    Effect.gen(function* () {
      const failure = yield* runCase("refuses a landline", () =>
        Effect.succeed({ messageId: "m1", segments: 1 }),
      );
      expect(failure.message).toBe(
        'Sms.send "refuses a landline": expected it to fail, but it returned {"messageId":"m1","segments":1}',
      );
    }),
  );

  it.effect("an error the expectation does not match fails the case", () =>
    Effect.gen(function* () {
      const failure = yield* runCase("says why it refuses", () =>
        Effect.fail(new Undeliverable({ reason: "blocked" })),
      );
      expect(failure.message).toBe(
        'Sms.send "says why it refuses": expected an error matching {"reason":"landline"}, got {"_tag":"Undeliverable","reason":"blocked"}',
      );
    }),
  );

  it.effect("an error the error schema rejects fails the case", () =>
    Effect.gen(function* () {
      const failure = yield* runCase("refuses a landline", () =>
        Effect.fail({ _tag: "Undeliverable" }),
      );
      expect(failure.message).toMatch(
        /^Sms\.send "refuses a landline": failed with an error its error schema rejects\n/,
      );
    }),
  );

  it.effect("a call that dies fails the case", () =>
    Effect.gen(function* () {
      const failure = yield* runCase("sends a message", () =>
        Effect.die(new Error("socket closed")),
      );
      expect(failure.message).toBe('Sms.send "sends a message": died with Error: socket closed');
    }),
  );

  it.effect("a case may expect any error of a declared list", () =>
    Effect.gen(function* () {
      class Cards extends Domain.ExternalSystem("Cards", {
        charge: { args: { amount: Schema.Int }, error: [RefundDeclined, CardFrozen] },
      }) {}
      const CardsContract = ExternalSystem.contract(Cards, {
        "refuses a frozen card": ExternalSystem.fails(Cards.charge, { amount: 500 }, "CardFrozen"),
      });
      const FrozenCards = Cards.toLayer(
        Effect.succeed({ charge: () => Effect.fail(new CardFrozen()) }),
      );
      yield* CardsContract["refuses a frozen card"].pipe(Effect.provide(FrozenCards));
    }),
  );

  it.effect("checks the schema even when the adapter skips validation", () =>
    Effect.gen(function* () {
      const failure = yield* SmsContract["sends a message"].pipe(
        Effect.flip,
        Effect.provide(
          Sms.toLayer(
            Effect.succeed({ send: () => Effect.succeed({ messageId: "m1", segments: 1.5 }) }),
            { validate: false },
          ),
        ),
      );
      expect(failure.message).toMatch(
        /^Sms\.send "sends a message": returned a value its success schema rejects\n.*segments/s,
      );
    }),
  );

  it("a case for another system's operation is refused", () => {
    expect(() =>
      ExternalSystem.contract(Sms, {
        "sends an email": ExternalSystem.returns(Email.send as never, { to: "a@b.c" }),
      }),
    ).toThrow("contract for Sms has a case for Email.send");
  });
});
