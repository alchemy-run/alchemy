import { Story } from "@alchemy.run/domain/Story";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  Careless,
  CarelessApi,
  Club,
  ClubApi,
  Park,
  ParkApi,
  Vague,
  VagueApi,
} from "./fixtures/Club.model.ts";

// A relation is about a few instances. It is proved where every
// command and every decision that records on its aggregates keeps it, from
// any states the model's rules allow.

it.effect(
  "relations that each side's decisions keep are proved together",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Club, {
        apis: [ClubApi],
        story: Story.make(Club, {}),
        walks: { count: 20 },
        require: { proved: ["Club.AMemberIsInTheirSeat", "Club.ATakenSeatHasItsMember"] },
      });
      expect(
        report.rules.map((rule) => ({ name: rule.name, kind: rule.kind, is: rule.standing })),
      ).toEqual([
        { name: "Club.AMemberIsInTheirSeat", kind: "relation", is: "proved" },
        { name: "Club.ATakenSeatHasItsMember", kind: "relation", is: "proved" },
      ]);
      expect(Verify.render(report)).toContain("✓ Club.AMemberIsInTheirSeat");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a relation too weak to prove itself is checked, and says what the proof fails on",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Vague, {
        apis: [VagueApi],
        story: Story.make(Vague, {}),
        walks: { count: 20 },
      });
      const rule = report.rules.find((rule) => rule.name === "Vague.ASeatedMembersSeatIsTaken");
      expect(rule?.standing).toBe("checked");
      // Two members who both say they hold one seat: nothing reaches it, and nothing rules it out.
      expect(rule?.unproved?.by).toBe("LeaveClub");
      expect(rule?.unproved?.verdict._tag).toBe("Violated");
      expect(Verify.render(report)).toMatch(/not proved: LeaveClub \{.*\} breaks it from/);
      // Asking for it to be proved fails the verification.
      const failed = yield* Verify.model(Vague, {
        apis: [VagueApi],
        story: Story.make(Vague, {}),
        walks: { count: 0 },
        require: { proved: ["Vague.ASeatedMembersSeatIsTaken"] },
      }).pipe(Effect.flip);
      expect(failed.message).toContain(
        "Vague.ASeatedMembersSeatIsTaken is required to be proved, and is only checked",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a relation one decision breaks fails with the commands that break it",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.model(Careless, {
        apis: [CarelessApi],
        story: Story.make(Careless, {}),
        walks: { count: 20 },
      }).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      const rule = failed.report.rules.find(
        (rule) => rule.name === "Careless.AMemberIsInTheirSeat",
      );
      expect(rule?.standing).toBe("broken");
      // A member takes a seat, and the seat is cleared from under them.
      expect(rule?.story?.map((step) => (step.command as { _tag: string })._tag)).toEqual([
        "JoinClub",
        "ClearSeat",
      ]);
      expect(failed.message).toContain("✗ Careless.AMemberIsInTheirSeat breaks");
      expect(failed.message).toMatch(/Story\.when\(new ClearSeat\(\{ seat: "[^"]*" \}\)\),/);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "an aggregate's own command that breaks a relation is named by the proof and found by the search",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.model(Park, {
        apis: [ParkApi],
        story: Story.make(Park, {}),
        walks: { count: 20 },
      }).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      const rule = failed.report.rules.find((rule) => rule.name === "Park.AMemberIsOnTheirBench");
      expect(rule?.standing).toBe("broken");
      expect(rule?.story?.map((step) => (step.command as { _tag: string })._tag)).toEqual([
        "SitDown",
        "Vacate",
      ]);
      // The proof fails on the same command, from any member on any taken bench.
      expect(rule?.unproved?.by).toBe("Bench.Vacate");
      expect(rule?.unproved?.verdict._tag).toBe("Violated");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
