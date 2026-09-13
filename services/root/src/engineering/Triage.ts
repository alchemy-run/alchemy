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
 * The TRIAGE QUEUE — the inbound queue the EngineeringManager fronts:
 * GitHub issues, pull requests, and ad-hoc direct requests, durable
 * (TriageDO), drained in STRICT FIFO order.
 *
 * Code, not an agent, PUMPS the world in: {@link TriagePump} subscribes
 * to every connected repository's events (a real webhook deployed; the
 * poller under `alchemy dev`), renders each delivery to one line, and
 * enqueues it — deduped on content (webhooks redeliver; the dev poller
 * re-synthesizes). A fresh item WAKES the manager, who consumes the
 * queue PULL-WISE with its tools: `take_inbound` hands it the head
 * (the same item again after a crash — nothing is lost mid-file),
 * `finish_inbound` acks it and moves on. One item at a time, in
 * arrival order — the strictness is the DO's sequence, not the
 * model's discipline.
 */

export interface Inbound {
  readonly seq: number;
  /** `owner/repo#N` when the item concerns a GitHub entity. */
  readonly ref?: string;
  readonly kind: "issue" | "pull" | "request";
  /** One rendered line — who did what. */
  readonly text: string;
  readonly at: number;
}

export class Triage extends Context.Service<
  Triage,
  {
    /** Enqueue one inbound item (deduped on `key`). Answers whether it
     *  was fresh and how many now wait. */
    readonly enqueue: (input: {
      readonly key: string;
      readonly ref?: string;
      readonly kind: Inbound["kind"];
      readonly text: string;
    }) => Effect.Effect<{ duplicate: boolean; waiting: number }>;
    /** The queue's head: the item already TAKEN (a redelivery — finish
     *  it first) or the oldest pending, now taken. */
    readonly take: () => Effect.Effect<{
      readonly item: Inbound | undefined;
      readonly waiting: number;
    }>;
    /** Ack the taken item — it is filed; the next take pops fresh. */
    readonly finish: () => Effect.Effect<void>;
    readonly waiting: () => Effect.Effect<number>;
  }
>()("Triage") {}

/** One GitHub delivery, rendered for the queue. */
export const inboundOf = (
  event: GitHub.RepositoryEvent,
): {
  readonly key: string;
  readonly ref?: string;
  readonly kind: Inbound["kind"];
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
    kind:
      event._tag.startsWith("PullRequest")
        ? "pull"
        : event._tag === "Push"
          ? "request"
          : "issue",
    text: line,
  };
};

/**
 * The PUMP: every GitHub event of every connected repository →
 * `Triage.enqueue` → a wake on the manager. The webhook handler
 * answers after the enqueue commits — processing is the manager's own
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
            const { duplicate, waiting } = yield* triage.enqueue(
              inboundOf(event),
            );
            if (duplicate) return;
            yield* manager
              .send(
                `[triage] ${waiting} inbound waiting — take_inbound, file, finish_inbound; repeat until empty`,
                { key: lineage("engineering-manager"), wake: true },
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("triage wake failed", cause),
                ),
              );
          }),
        ),
      { discard: true },
    );
  }),
);
