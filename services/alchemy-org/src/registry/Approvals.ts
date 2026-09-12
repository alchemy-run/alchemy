import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import { Channel, parseEntityRef } from "../channel/Channel.ts";
import { nameOf, primary } from "../github/Repos.ts";
import { Registry, type RegistryApproval } from "./Registry.ts";

/**
 * DECIDING an approval — the human's click on the card.
 *
 * Deny: mark denied, flip the card, steer the stager with the reason.
 *
 * Approve: kinds the Worker can perform itself (comment, merge,
 * close — plain GitHub API calls on the org credential) execute HERE,
 * then mark executed|failed and report. Kinds that need the stager's
 * own machine (push, open_pull — they run inside the engineer's
 * sandbox) are marked approved and the stager is steered to retry the
 * tool: its gated Layer finds the approved row and goes through.
 */
export const makeDecideApproval = Effect.gen(function* () {
  const registry = yield* Registry;
  const channel = yield* Channel;
  const sessions = yield* AI.Sessions;
  const createComment = yield* GitHub.CreateIssueComment(primary);
  const mergePull = yield* GitHub.MergePullRequest(primary);
  const updateIssue = yield* GitHub.UpdateIssue(primary);
  const repo = nameOf(primary);

  /** Flip the surfacing card in place, so every view updates. */
  const flip = Effect.fn(function* (
    approval: RegistryApproval,
    decided: "approved" | "denied" | "executed" | "failed",
    outcome?: string,
  ) {
    if (approval.cardId === undefined) return;
    const [card] = yield* channel.read([approval.cardId]);
    if (card?.card === undefined) return;
    yield* channel.update(approval.cardId, {
      ...(outcome === undefined
        ? {}
        : { text: `${card.text}\n\n— ${outcome}` }),
      card: {
        ...card.card,
        approval: { id: approval.id, kind: approval.kind, decided },
      },
    });
  });

  /** Tell the session that staged it — work resumes on the outcome. */
  const notify = Effect.fn(function* (
    approval: RegistryApproval,
    outcome: string,
  ) {
    yield* sessions
      .send(
        approval.stager.term,
        approval.stager.key,
        `[approval ${approval.id}] ${approval.summary}: ${outcome}`,
      )
      .pipe(Effect.ignore);
  });

  /** The Worker-executable kinds; answers a one-line outcome. */
  const execute = Effect.fn(function* (approval: RegistryApproval) {
    const payload = approval.payload;
    const numberOf = (ref: string) => {
      const parsed = parseEntityRef(ref);
      if (parsed === undefined) {
        return Effect.fail(new Error(`bad ref ${ref}`));
      }
      if (`${parsed.owner}/${parsed.repo}` !== repo) {
        return Effect.fail(
          new Error(`${ref} is not in the connected repository ${repo}`),
        );
      }
      return Effect.succeed(parsed.number);
    };
    switch (payload.kind) {
      case "comment": {
        const issueNumber = yield* numberOf(payload.ref);
        const comment = yield* createComment({
          issue_number: issueNumber,
          body: payload.body,
        });
        return `commented — ${comment.html_url}`;
      }
      case "merge": {
        const pullNumber = yield* numberOf(payload.ref);
        const merged = yield* mergePull({ pull_number: pullNumber });
        return merged.merged === true
          ? `merged ${payload.ref}`
          : `merge not performed: ${merged.message ?? "unknown"}`;
      }
      case "close": {
        const issueNumber = yield* numberOf(payload.ref);
        yield* updateIssue({ issue_number: issueNumber, state: "closed" });
        return `closed ${payload.ref}`;
      }
      // sandbox-bound kinds never reach here (see decide below)
      case "push":
      case "open_pull":
        return "approved";
    }
  });

  return Effect.fn(function* (
    id: string,
    decision: "approve" | "deny",
    reason?: string,
  ) {
    const approval = yield* registry.readApproval(id);
    if (approval === undefined || approval.status !== "pending") {
      return approval;
    }

    if (decision === "deny") {
      const outcome = reason === undefined ? "denied" : `denied — ${reason}`;
      const next = yield* registry.decideApproval(id, "denied", outcome);
      yield* flip(approval, "denied", outcome);
      yield* notify(approval, outcome);
      return next;
    }

    // sandbox-bound kinds: mark approved, steer the stager to retry —
    // its gated Layer finds the approved row and performs the act on
    // the machine that has the work
    if (approval.kind === "push" || approval.kind === "open_pull") {
      const next = yield* registry.decideApproval(id, "approved");
      yield* flip(approval, "approved");
      yield* notify(
        approval,
        "approved — run the tool again; it will go through now",
      );
      return next;
    }

    const outcome = yield* execute(approval).pipe(
      Effect.map((line) => ({ status: "executed" as const, line })),
      Effect.catch((error) =>
        Effect.succeed({
          status: "failed" as const,
          line: `failed — ${String(error)}`,
        }),
      ),
    );
    const next = yield* registry.decideApproval(
      id,
      outcome.status,
      outcome.line,
    );
    yield* flip(approval, outcome.status, outcome.line);
    yield* notify(approval, outcome.line);
    return next;
  });
});
