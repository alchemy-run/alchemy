import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Account } from "../src/Account/Account.aggregate.ts";
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
