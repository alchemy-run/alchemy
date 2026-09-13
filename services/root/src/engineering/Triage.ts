import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { connected } from "../github/Repos.ts";
import { lineage } from "../Root.ts";
import { EngineeringManager } from "./Manager.ts";

/**
 * TRIAGE — the pump that turns the outside world into the
 * EngineeringManager's inbound stream.
 *
 * THE SESSION IS THE QUEUE. A session's inbox is already a durable,
 * seq-ordered, crash-consistent mailbox whose engine DRIVES the agent:
 * a waking input opens a round, inputs that arrive mid-round open the
 * next one, and an interrupted round recovers over the thread where
 * every admitted event already sits. So triage adds only what the
 * mailbox lacks: DEDUPE (webhooks redeliver; the dev poller
 * re-synthesizes) — one row per event key, in TriageDO beside the task
 * ledger — and RENDERING (one `[inbound]` line per event). Everything
 * else — ordering, durability, waking, redelivery — is the driver's.
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

/**
 * The PUMP: every GitHub event of every connected repository, deduped,
 * delivered straight into the manager's SESSION as one waking input —
 * the engine does the queueing and the driving. The webhook handler
 * answers after the send commits; processing is the manager's own
 * pace, never the webhook's timeout.
 */
export const TriagePump = Layer.effectDiscard(
  Effect.gen(function* () {
    const triage = yield* Triage;
    const manager = yield* EngineeringManager;
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
            yield* manager
              .send(
                `[inbound${inbound.ref === undefined ? "" : ` ${inbound.ref}`}] ${inbound.text}`,
                { key: lineage("engineering-manager"), wake: true },
              )
              .pipe(
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
