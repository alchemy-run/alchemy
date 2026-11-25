import * as AI from "@alchemy.run/ai";
import { Story } from "@alchemy.run/domain/Story";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Board } from "../src/Board/Board.model.ts";
import { BoardApi } from "../src/Board/BoardApi.api.ts";
import { IssueWorkLive } from "../src/Board/IssueWork.policy.ts";
import { Triage } from "../src/Board/Triage.process.ts";

// Each sequence the explorer finds is also run on the real board, in memory.
// Triage is played by a stand-in that does nothing: the rules must hold
// whatever a session does, and the explorer sends a session's commands itself.
const TriageIdle = AI.scripted(
  Triage,
  Effect.succeed(() => Effect.succeed("")),
);
const story = Story.make(Board, { layer: Layer.mergeAll(IssueWorkLive, TriageIdle) });

it.effect(
  "no command, from a person or a session, breaks the board's rules",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.report(Board, {
        apis: [BoardApi],
        story,
        // A rule that slips from proved to checked fails this.
        require: {
          proved: [
            "Issue.RepliesAreCounted",
            "Issue.AReportedIssueStaysReported",
            "Issue.OnlyLabelingChangesTheLabel",
            "Issue.NoReplyIsLost",
          ],
        },
      });
      expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual({
        // No state and no input break these: a solver decides each.
        "Issue.RepliesAreCounted": "proved",
        "Issue.AReportedIssueStaysReported": "proved",
        "Issue.OnlyLabelingChangesTheLabel": "proved",
        "Issue.NoReplyIsLost": "proved",
        // What the board must be able to do: a sequence of commands gets there.
        "Board.AnIssueGetsLabeled": "reached",
      });
      expect(report.undone).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
