import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { connected } from "../github/Repos.ts";
import { inWorker } from "../platform/Database.ts";
import { lineage } from "../Root.ts";

/**
 * TRIAGE — the pump that turns the outside world into messages in the
 * ENGINEERING CHANNEL.
 *
 * THE CHANNEL IS THE MANAGER'S SESSION (every group's channel is its
 * head's session), and A SESSION IS ALREADY A QUEUE: a durable,
 * seq-ordered inbox whose driver opens a round per waking input, one
 * by one, and keeps going while inputs remain. So every GitHub event
 * becomes ONE MESSAGE in #engineering — pushed straight through; the
 * humans' flow control is the channel's STOP/RESUME button (the
 * driver parks the session; the backlog waits durably; resume picks
 * the work back up). Triage itself adds only DEDUPE: webhooks
 * redeliver and the dev poller re-synthesizes; one row per event key
 * (TriageDO, beside the task ledger).
 */

export type InboundKind = "issue" | "pull" | "request";

export class Triage extends Context.Service<
  Triage,
  {
    /** Record one event key; answers whether it was already seen. */
    readonly delivered: (key: string) => Effect.Effect<boolean>;
  }
>()("Triage") {}

/** One GitHub delivery, rendered for the manager's inbox. */
export const inboundOf = (
  event: GitHub.RepositoryEvent,
): {
  readonly key: string;
  readonly ref?: string;
  readonly kind: InboundKind;
  readonly text: string;
} => {
  const repo = `${event.repository.owner.login}/${event.repository.name}`;
  const ref = GitHub.eventKey(event);
  const who =
    event._tag === "Push" ? undefined : (event.sender?.login ?? undefined);
  const by = who === undefined ? "" : `${who} `;
  const line = (() => {
    switch (event._tag) {
      case "IssueOpened":
        return `${by}opened issue ${ref} — ${event.issue.title}`;
      case "IssueLabeled":
        return `${by}labeled ${ref} \`${event.label.name}\``;
      case "IssueClosed":
        return `${by}closed issue ${ref} — ${event.issue.title}`;
      case "IssueCommented":
        return `${by}commented on ${ref}: ${(event.comment.body ?? "").split("\n", 1)[0]!.slice(0, 140)}`;
      case "PullRequestOpened":
        return `${by}opened pull request ${ref} — ${event.pullRequest.title}`;
      case "PullRequestSynchronized":
        return `${by}pushed to pull request ${ref} — ${event.pullRequest.title}`;
      case "PullRequestMerged":
        return `${by}merged pull request ${ref} — ${event.pullRequest.title}`;
      case "PullRequestClosed":
        return `${by}closed pull request ${ref} without merging`;
      case "Push":
        return `pushed to \`${event.branch}\` in ${repo}${
          event.headCommit === null
            ? ""
            : ` — ${event.headCommit.message.split("\n", 1)[0]}`
        }`;
    }
  })();
  return {
    key: JSON.stringify(event),
    ...(ref === undefined ? {} : { ref }),
    kind: (event._tag.startsWith("PullRequest")
      ? "pull"
      : event._tag === "Push"
        ? "request"
        : "issue") as InboundKind,
    text: line,
  };
};

/** Where the pump delivers: the engineering channel — the manager's
 *  session. */
export const MANAGER_ADDRESS = {
  term: "Manager",
  key: lineage("manager"),
} as const;

/**
 * The PUMP: every GitHub event of every connected repository, deduped,
 * pushed as ONE MESSAGE into #engineering. The webhook handler answers
 * after the send commits; processing is the channel's pace (and its
 * stop button), never the webhook's timeout.
 */
export const TriagePump = Layer.effectDiscard(
  Effect.gen(function* () {
    const triage = yield* Triage;
    const sessions = yield* AI.Sessions;
    const secret = yield* Config.option(
      Config.Redacted("GITHUB_WEBHOOK_SECRET"),
    );
    if (Option.isNone(secret)) {
      yield* Effect.logWarning(
        "TriagePump: no GITHUB_WEBHOOK_SECRET — deliveries are accepted unverified",
      );
    }

    yield* Effect.forEach(
      connected,
      (entry) =>
        GitHub.consumeRepositoryEvents(
          entry.repository,
          {
            events: [
              GitHub.IssueOpened,
              GitHub.IssueLabeled,
              GitHub.IssueClosed,
              GitHub.IssueCommented,
              GitHub.PullRequestOpened,
              GitHub.PullRequestSynchronized,
              GitHub.PullRequestClosed,
              GitHub.PullRequestMerged,
              GitHub.Push,
            ],
            ...(Option.isSome(secret) ? { secret: secret.value } : {}),
          },
          Effect.fn(function* (event) {
            const inbound = inboundOf(event);
            if (yield* triage.delivered(inbound.key)) return;
            yield* sessions
              .send(
                MANAGER_ADDRESS.term,
                MANAGER_ADDRESS.key,
                `[inbound${inbound.ref === undefined ? "" : ` ${inbound.ref}`}] ${inbound.text}`,
                { wake: true },
              )
              .pipe(
                inWorker,
                Effect.catchCause((cause) =>
                  Effect.logWarning("inbound delivery failed", cause),
                ),
              );
          }),
        ),
      { discard: true },
    );
  }),
);

