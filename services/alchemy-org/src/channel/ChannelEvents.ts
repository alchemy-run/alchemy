import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { connected } from "../github/Repos.ts";
import { ThreadAgent } from "../thread/ThreadAgent.ts";
import { Threads } from "../thread/Threads.ts";
import { Channel } from "./Channel.ts";

/**
 * INGEST: GitHub webhooks → the channel. One consumer per connected
 * repository; every delivery becomes exactly one `deliver` on the one
 * ChannelDO — dedupe on content, the event row appended with the real
 * GitHub actor, the owning thread named when the ref is attached. The
 * webhook handler completes (and GitHub gets its 2xx) only after
 * `deliver` returns.
 *
 * An OWNED event additionally reaches its thread: the ThreadDO's
 * entity state converges (merged/closed/reopened) and the thread
 * agent hears the event as non-waking input — context, not a trigger;
 * the agent reads it at its next wake.
 *
 * Nothing else runs on ingest. The channel agent runs ONLY on the
 * operator's messages (`POST /api/channel`); routing decisions —
 * which thread should exist, what belongs where — are the operator's
 * conversation with it, never a background process.
 */
export const ChannelEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    const channel = yield* Channel;
    const threads = yield* Threads;
    const agent = yield* ThreadAgent;
    const secret = yield* Config.option(
      Config.redacted("GITHUB_WEBHOOK_SECRET"),
    );
    if (Option.isNone(secret)) {
      yield* Effect.logWarning(
        "ChannelEvents: no GITHUB_WEBHOOK_SECRET — deliveries are accepted unverified",
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
            const { duplicate, owner } = yield* channel.deliver(event);
            if (duplicate || owner === undefined) return;
            // the owning thread: entity state first (facts), then the
            // agent hears it — a routing failure never costs the
            // channel its row (deliver already committed)
            yield* threads.noteEvent(owner, event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `thread ${owner}: noteEvent failed`,
                  cause,
                ),
              ),
            );
            yield* agent
              .send(event, { key: owner, wake: false })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `thread ${owner}: agent delivery failed`,
                    cause,
                  ),
                ),
              );
          }),
        ),
      { discard: true },
    );
  }),
);
