import * as Explore from "@alchemy.run/domain/Explore";
import * as Prove from "@alchemy.run/domain/Prove";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Account } from "../src/Account/Account.aggregate.ts";
import { Bank } from "../src/Bank.model.ts";
import { CustomerApi } from "../src/CustomerApi.api.ts";
import { SupportApi } from "../src/SupportApi.api.ts";
import { Receipt } from "./fixtures/Receipt.aggregate.ts";

// What a project that installs the published package does first. This file
// and `src` are also copied into a project outside the workspace and run
// against the packed packages (`scripts/test-domain-consumer.ts`): there the
// package is not source the test runner transforms, so the files it reads
// are loaded a second time, and the classes have to be matched to the test's.

it.effect(
  "an aggregate is verified from the file the test imports",
  () => Verify.aggregate(Account).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a model's aggregates are found in the files its file imports",
  () =>
    Effect.gen(function* () {
      const report = yield* Explore.report(Bank, {
        source: new URL("../src/Bank.model.ts", import.meta.url),
        apis: [CustomerApi, SupportApi],
        depth: 1,
      });
      expect(report.sequences).toBeGreaterThan(0);
      expect(report.decisions).toEqual(["RegisterCustomer"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);

it.effect(
  "a helper the prover cannot read is found in the files it loads itself",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Receipt, {
        source: new URL("./fixtures/Receipt.aggregate.ts", import.meta.url),
        opaque: [DateTime.formatIso],
      });
      const rule = report.invariants.find((rule) => rule.name === "TheCopyIsTheId")!;
      expect(rule.commands.map((command) => command.verdict)).toEqual([{ _tag: "Proved" }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
