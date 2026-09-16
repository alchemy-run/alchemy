import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { parseEntityRef } from "../github/Entity.ts";
import { nameOf, primary } from "../github/Repos.ts";
import { Proposals, type Proposal } from "./Proposals.ts";

/**
 * DECIDING a proposal — the human's click on the Root Thread card.
 *
 * - `GET  /api/proposals`      — the queue (`?status=pending` filters)
 * - `GET  /api/proposals/:id`  — one proposal's live row (the card polls)
 * - `POST /api/proposals/:id`  — `{ decision: "approve"|"deny", reason? }`
 *
 * Deny: mark denied, steer the proposer with the reason. Approve:
 * kinds the Worker performs itself (comment, merge, close — plain
 * GitHub API calls on the org credential) execute HERE, then mark
 * executed|failed and report; kinds that need the proposer's own
 * machine (push, open_pull — they run inside the workspace) are marked
 * approved and the proposer is steered to retry the tool — its gated
 * Layer (coding/Gate.ts) finds the approved row and goes through.
 */
export const DecideApi = Effect.gen(function* () {
  const proposals = yield* Proposals;
  const sessions = yield* AI.Sessions;
  const createComment = yield* GitHub.CreateIssueComment(primary);
  const mergePull = yield* GitHub.MergePullRequest(primary);
  const updateIssue = yield* GitHub.UpdateIssue(primary);
  const repo = nameOf(primary);

  /** Tell the session that proposed it — work resumes on the outcome. */
  const notify = Effect.fn(function* (proposal: Proposal, outcome: string) {
    yield* sessions
      .send(
        proposal.proposer.term,
        proposal.proposer.key,
        `[proposal ${proposal.id}] ${proposal.summary}: ${outcome}`,
      )
      .pipe(Effect.ignore);
  });

  /** The Worker-executable kinds; answers a one-line outcome. */
  const execute = Effect.fn(function* (proposal: Proposal) {
    const payload = proposal.payload;
    const numberOf = (entity: string) => {
      const parsed = parseEntityRef(entity);
      if (parsed === undefined) {
        return Effect.fail(new Error(`bad ref ${entity}`));
      }
      if (`${parsed.owner}/${parsed.repo}` !== repo) {
        return Effect.fail(
          new Error(`${entity} is not in the connected repository ${repo}`),
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
      // workspace-bound kinds never reach here (see decide below)
      case "push":
      case "open_pull":
        return "approved";
    }
  });

  const decide = Effect.fn(function* (
    id: string,
    decision: "approve" | "deny",
    reason?: string,
  ) {
    const proposal = yield* proposals.read(id);
    if (proposal === undefined || proposal.status !== "pending") {
      return proposal;
    }

    if (decision === "deny") {
      const outcome = reason === undefined ? "denied" : `denied — ${reason}`;
      const next = yield* proposals.mark(id, "denied", outcome);
      yield* notify(proposal, outcome);
      return next;
    }

    // workspace-bound kinds: mark approved, steer the proposer to
    // retry — its gated Layer finds the approved row and performs the
    // act on the machine that has the work
    if (proposal.kind === "push" || proposal.kind === "open_pull") {
      const next = yield* proposals.mark(id, "approved");
      yield* notify(
        proposal,
        "approved — run the tool again; it will go through now",
      );
      return next;
    }

    const outcome = yield* execute(proposal).pipe(
      Effect.map((line) => ({ status: "executed" as const, line })),
      Effect.catch((error) =>
        Effect.succeed({
          status: "failed" as const,
          line: `failed — ${String(error)}`,
        }),
      ),
    );
    const next = yield* proposals.mark(id, outcome.status, outcome.line);
    yield* notify(proposal, outcome.line);
    return next;
  });

  const missing = HttpServerResponse.json(
    { error: "no such proposal" },
    { status: 404 },
  );

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/proposals",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const status = new URL(request.url, "http://worker").searchParams.get(
          "status",
        );
        return yield* HttpServerResponse.json({
          proposals: yield* proposals.list(
            status === null ? undefined : (status as Proposal["status"]),
          ),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/api/proposals/:id",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const found = yield* proposals.read(String(params.id ?? ""));
        return found === undefined
          ? yield* missing
          : yield* HttpServerResponse.json(found);
      }),
    ),
    HttpRouter.add(
      "POST",
      "/api/proposals/:id",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const request = yield* HttpServerRequest;
        const posted = (yield* request.json.pipe(
          Effect.catch(() => Effect.succeed({})),
        )) as { decision?: unknown; reason?: unknown };
        if (posted.decision !== "approve" && posted.decision !== "deny") {
          return yield* HttpServerResponse.json(
            { error: 'decision must be "approve" or "deny"' },
            { status: 400 },
          );
        }
        const next = yield* decide(
          String(params.id ?? ""),
          posted.decision,
          typeof posted.reason === "string" ? posted.reason : undefined,
        );
        return next === undefined
          ? yield* missing
          : yield* HttpServerResponse.json(next);
      }),
    ),
  );
});
