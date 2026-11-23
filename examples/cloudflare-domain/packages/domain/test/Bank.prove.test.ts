import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Account } from "../src/Account/Account.aggregate.ts";
import { ForgetOwner } from "../src/Account/ForgetOwner.rewrite.ts";
import { Registration } from "../src/Customer/Registration.decision.ts";

it.effect(
  "no command can break an account's invariants",
  () =>
    Prove.invariants(Account, {
      source: new URL("../src/Account/Account.aggregate.ts", import.meta.url),
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "no registration gives a name to two customers",
  () =>
    // The decision keeps the rule of the username it claims, and its own about both instances.
    Prove.decision(Registration, {
      source: new URL("../src/Customer/Registration.decision.ts", import.meta.url),
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "forgetting an account's owner breaks none of its rules, whatever the account did",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.rewrite(ForgetOwner, {
        source: new URL("../src/Account/ForgetOwner.rewrite.ts", import.meta.url),
      });
      // The name is all it can change: the balance and the day's withdrawals are what they were.
      expect(report.differs).toEqual(["owner"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
