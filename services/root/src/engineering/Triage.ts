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
 * TRIAGE — the VALVE between the outside world and the
 * EngineeringManager.
 *
 * THE SESSION IS STILL THE QUEUE the manager consumes (a durable,
 * seq-ordered inbox whose driver wakes it); triage sits IN FRONT of it
 * so the humans control the FLOW: every GitHub event lands HELD in the
 * triage queue (deduped — webhooks redeliver, the dev poller
 * re-synthesizes), and only a RELEASE delivers it into the manager's
 * inbox. Two modes, one delivery path:
 *
 * - `manual` (the default, while the company is young): items wait;
 *   the UI's triage panel releases them one by one or all at once —
 *   the human decides when a message may be processed.
 * - `auto`: the pump releases immediately on arrival — the valve is
 *   open; flip it in the UI when the company has earned it.
 */

export type InboundKind = "issue" | "pull" | "request";

export type TriageMode = "manual" | "auto";

/** One held inbound item. */
export interface HeldInbound {
  readonly seq: number;
  /** `owner/repo#N` when the item concerns a GitHub entity. */
  readonly ref?: string;
  readonly kind: InboundKind;
  /** One rendered line — who did what. */
  readonly text: string;
  readonly at: number;
}

export class Triage extends Context.Service<
  Triage,
  {
    /** Hold one inbound item (deduped on `key`); in `auto` mode it is
     *  released in the same breath. Answers whether it was fresh. */
    readonly enqueue: (input: {
      readonly key: string;
      readonly ref?: string;
      readonly kind: InboundKind;
      readonly text: string;
    }) => Effect.Effect<{ duplicate: boolean }>;
    /** The held items, oldest first — the UI's triage panel. */
    readonly held: () => Effect.Effect<ReadonlyArray<HeldInbound>>;
    /**
     * RELEASE held items (specific seqs, or the whole queue), oldest
     * first: each is delivered into the manager's session inbox as one
     * waking input and leaves the held queue. Answers what was
     * released.
     */
    readonly release: (
      seqs?: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlyArray<HeldInbound>>;
    readonly mode: () => Effect.Effect<TriageMode>;
    readonly setMode: (mode: TriageMode) => Effect.Effect<void>;
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

/** The one line a released item becomes in the manager's inbox. */
export const renderInbound = (item: HeldInbound): string =>
  `[inbound${item.ref === undefined ? "" : ` ${item.ref}`}] ${item.text}`;

/** Where releases deliver: the manager's session. */
export const MANAGER_ADDRESS = {
  term: "EngineeringManager",
  key: lineage("engineering-manager"),
} as const;

/**
 * The PUMP: every GitHub event of every connected repository, deduped,
 * HELD in triage (and released in the same breath when the valve is
 * open). The webhook handler answers after the hold commits;
 * processing is the humans' valve and the manager's pace, never the
 * webhook's timeout.
 */
export const TriagePump = Layer.effectDiscard(
  Effect.gen(function* () {
    const triage = yield* Triage;
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
            yield* triage
              .enqueue(inboundOf(event))
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.as(
                    Effect.logWarning("triage hold failed", cause),
                    { duplicate: true },
                  ),
                ),
              );
          }),
        ),
      { discard: true },
    );
  }),
);

/**
 * The RELEASE delivery, shared by the manual button and the auto
 * valve — ONE code path: each released item becomes one waking input
 * in the manager's session inbox.
 */
export const deliverReleased = (
  released: ReadonlyArray<HeldInbound>,
): Effect.Effect<void, never, AI.Sessions> =>
  Effect.gen(function* () {
    const sessions = yield* AI.Sessions;
    yield* Effect.forEach(
      released,
      (item) =>
        inWorker(
          sessions.send(
            MANAGER_ADDRESS.term,
            MANAGER_ADDRESS.key,
            renderInbound(item),
            { wake: true },
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("inbound delivery failed", cause),
          ),
        ),
      { discard: true },
    );
  });
