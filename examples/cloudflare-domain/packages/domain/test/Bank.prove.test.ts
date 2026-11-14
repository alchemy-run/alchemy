import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Account } from "../src/Account/Account.aggregate.ts";

it.effect(
  "no command can break an account's invariants",
  () =>
    Prove.invariants(Account, {
      source: new URL("../src/Account/Account.aggregate.ts", import.meta.url),
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
