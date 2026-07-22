import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { pr } from "../vocabulary.ts";

export class Approve extends AI.Tool<Approve>()("approve")`
Request approval to merge ${pr}. Returns approved, or rejected with
reasons you must address before asking again.` {}

/**
 * The autonomy dial's LOCAL position: log the request and
 * auto-approve, loudly. TODO(HumanGate): replace with a real approval
 * surface (Slack / GitHub review / console prompt) — the human gate is
 * deliberately visible in every approval this returns.
 */
export const ApproveConsole = Layer.succeed(Approve, ((input: {
  pr: { owner: string; repository: string; number: number; url: string };
}) =>
  Effect.gen(function* () {
    yield* Effect.logWarning(
      `ApproveConsole AUTO-APPROVING ${input.pr.owner}/${input.pr.repository}#${input.pr.number} — no human gate is wired (TODO: HumanGate)`,
    );
    return `approved (WARNING: auto-approved by ApproveConsole — no human reviewed this)`;
  })) as never);
