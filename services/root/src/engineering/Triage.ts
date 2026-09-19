import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { connected } from "../github/Repos.ts";
import { inWorker } from "../platform/Database.ts";
import { lineage } from "../Lineage.ts";
import { TaskIntake } from "../tasks/Intake.ts";
import { handleBurst } from "./Burst.ts";
import type { InboundEvent } from "./Swarm.ts";
import { swarmDeps } from "./SwarmLive.ts";

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
 * (TriageDO).
 */

export type InboundKind = "issue" | "pull" | "request";

export class Triage extends Context.Service<
  Triage,
  {
    /** Record one event key; answers whether it was already seen. */
    readonly delivered: (key: string) => Effect.Effect<boolean>;
    /** Queue one rendered event for the batcher; answers the depth. */
    readonly pend: (event: string) => Effect.Effect<number>;
    /** Drain the queue atomically (empty when already claimed). */
    readonly claim: () => Effect.Effect<ReadonlyArray<string>>;
  }
>()("Triage") {}

/** One GitHub delivery, rendered for the manager's inbox. */
export const inboundOf = (
  event: GitHub.RepositoryEvent,
): { readonly key: string } & Pended => {
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
  const number =
    event._tag === "Push"
      ? undefined
      : event._tag.startsWith("PullRequest")
        ? (event as { pullRequest: { number: number } }).pullRequest.number
        : (event as { issue: { number: number } }).issue.number;
  const title =
    event._tag === "Push"
      ? undefined
      : event._tag.startsWith("PullRequest")
        ? (event as { pullRequest: { title: string } }).pullRequest.title
        : (event as { issue: { title: string } }).issue.title;
  return {
    key: JSON.stringify(event),
    ...(ref === undefined ? {} : { ref }),
    kind: (event._tag.startsWith("PullRequest")
      ? "pull"
      : event._tag === "Push"
        ? "request"
        : "issue") as InboundKind,
    text: line,
    repo,
    ...(number === undefined ? {} : { number }),
    ...(title === undefined ? {} : { title }),
  };
};

/** Where the pump delivers: the engineering channel — the manager's
 *  session. */
export const MANAGER_ADDRESS = {
  term: "Manager",
  key: lineage("manager"),
} as const;

/** One pended event, as the batcher stores and drains it. */
export interface Pended {
  readonly text: string;
  readonly ref?: string;
  readonly kind: InboundKind;
  readonly repo?: string;
  readonly number?: number;
  readonly title?: string;
}

/** How many pended events make a burst worth a walker. */
export const BURST_AT = 3;

/**
 * The batch DECISION, pure: a drained queue either bursts (≥
 * {@link BURST_AT} events that carry enough identity to swarm over)
 * or degrades to today's path — one channel message per event. Events
 * without identity (pushes) always take the single path.
 */
export const planBatch = (
  batch: ReadonlyArray<Pended>,
): {
  readonly burst: ReadonlyArray<InboundEvent>;
  readonly singles: ReadonlyArray<Pended>;
} => {
  const burstable = batch.filter(
    (
      entry,
    ): entry is Pended & {
      repo: string;
      number: number;
      title: string;
      kind: "issue" | "pull";
    } =>
      entry.repo !== undefined &&
      entry.number !== undefined &&
      entry.title !== undefined &&
      (entry.kind === "issue" || entry.kind === "pull"),
  );
  if (burstable.length >= BURST_AT) {
    return {
      burst: burstable.map((entry) => ({
        repo: entry.repo,
        number: entry.number,
        title: entry.title,
        kind: entry.kind as InboundEvent["kind"],
      })),
      singles: batch.filter(
        (entry) => !(burstable as ReadonlyArray<Pended>).includes(entry),
      ),
    };
  }
  return { burst: [], singles: batch };
};

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

    const handleInbound = Effect.fn(function* (event: GitHub.RepositoryEvent) {
      const inbound = inboundOf(event);
      if (yield* triage.delivered(inbound.key)) return;
      // THE BATCHER: arrivals pend; the third arrival flushes
      // immediately, a lone arrival flushes after the debounce.
      // A burst becomes ONE walker run (Burst.ts); anything else
      // degrades to today's path — one message per event.
      const depth = yield* triage.pend(JSON.stringify(inbound)).pipe(
        inWorker,
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning("inbound pend failed", cause),
            BURST_AT, // fail open: flush now, lose nothing
          ),
        ),
      );
      const flush = Effect.gen(function* () {
        const drained = yield* triage.claim().pipe(inWorker);
        if (drained.length === 0) return; // someone else claimed
        const batch = drained.map((entry) => JSON.parse(entry) as Pended);
        const plan = planBatch(batch);
        if (plan.burst.length > 0) {
          const deps = yield* swarmDeps;
          yield* handleBurst(
            deps("engineering"),
            "engineering",
            plan.burst,
          ).pipe(inWorker);
        }
        // singles keep the manager's message (informational) AND file
        // a task through the intake router when one is wired — events
        // with identity become board work; pushes stay chatter
        const intake = yield* Effect.serviceOption(TaskIntake);
        yield* Effect.forEach(
          plan.singles,
          (single) =>
            Effect.gen(function* () {
              yield* sessions
                .send(
                  MANAGER_ADDRESS.term,
                  MANAGER_ADDRESS.key,
                  `[inbound${single.ref === undefined ? "" : ` ${single.ref}`}] ${single.text}`,
                  { wake: true },
                )
                .pipe(inWorker);
              if (
                Option.isSome(intake) &&
                single.title !== undefined &&
                single.repo !== undefined &&
                single.number !== undefined
              ) {
                yield* intake.value
                  .file({
                    title: single.title,
                    body: single.text,
                    origin: `github:${single.repo}#${single.number}`,
                    actor: "router",
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("inbound task filing failed", cause),
                    ),
                  );
              }
            }),
          { discard: true },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("inbound delivery failed", cause),
        ),
      );
      if (depth >= BURST_AT) {
        yield* flush;
      } else {
        // the debounce sleeper must outlive the webhook request
        const exec = yield* Cloudflare.WorkerExecutionContext;
        yield* exec.waitUntil(
          Effect.andThen(Effect.sleep("25 seconds"), flush),
        );
      }
    });

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
          (event) =>
            handleInbound(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("triage intake failed", cause),
              ),
            ),
        ),
      { discard: true },
    );
  }),
);
