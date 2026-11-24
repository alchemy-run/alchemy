import * as Prove from "@alchemy.run/domain/Prove";
import { Story } from "@alchemy.run/domain/Story";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Lax, Member, Roster, RosterApi } from "./fixtures/Roster.model.ts";

const source = new URL("./fixtures/Roster.model.ts", import.meta.url);

it.effect(
  "a model with sealed fields is verified: its rules read the subject, never the value",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Roster, {
        apis: [RosterApi],
        source,
        story: Story.make(Roster),
        walks: { count: 0 },
      });
      expect(Verify.verified(report)).toBe(true);
      expect(report.rules.find((rule) => rule.name === "Member.TheNameIsTheirOwn")?.standing).toBe(
        "proved",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "an aggregate that takes a name sealed for someone else is shown the command",
  () =>
    Effect.gen(function* () {
      yield* Prove.invariants(Member, { source });
      const failed = yield* Prove.invariants(Lax, { source }).pipe(Effect.flip);
      expect(failed.message).toContain("TheNameIsTheirOwn");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
