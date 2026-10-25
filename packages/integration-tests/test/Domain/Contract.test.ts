import * as Domain from "@alchemy.run/domain";
import * as ExternalSystem from "@alchemy.run/domain/ExternalSystem";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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

  it("a case for another system's operation is refused", () => {
    expect(() =>
      ExternalSystem.contract(Sms, {
        "sends an email": ExternalSystem.returns(Email.send as never, { to: "a@b.c" }),
      }),
    ).toThrow("contract for Sms has a case for Email.send");
  });
});
