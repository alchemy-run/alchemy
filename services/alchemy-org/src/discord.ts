/**
 * The FrontDesk process — the org's front desk on Discord. A mention
 * is a request in natural language; this process turns it into the
 * org's durable artifacts (an issue, a link to prior art) and answers
 * in the thread it was asked in.
 *
 * It deliberately owns NO engineering tools: work happens because an
 * issue exists and the Issues process picks it up — never because a
 * chat message shortcut-ed the process. Note it never references
 * ${Issues} either: the handoff artifact is the issue itself.
 *
 * SEALED by construction: {@link FrontDesk} is a plain
 * `Context.Service` resolving to {@link FrontDeskService}, and the
 * world drives the loop through the Discord event source — how
 * mentions arrive (gateway websocket, REST polling locally,
 * interactions webhook on Cloudflare) is decided entirely by which
 * `Discord.ServerEventSource` Layer is provided at composition. One
 * run per thread — a thread is a conversation, and follow-up
 * mentions steer it.
 */
import * as AI from "alchemy/AI";
import * as Discord from "alchemy/Discord";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Ledger } from "./ledger.ts";
import { testAlchemy } from "./repos.ts";
import { OpenIssue, Reply, SearchIssues } from "./tools/index.ts";

/**
 * What the org may ask of the FrontDesk from code. `mention` is a
 * manual injection door (tests, a bespoke substrate); the normal
 * path is the event source wired inside {@link FrontDeskLive}.
 * Colored `RuntimeContext` — deliveries only happen inside the
 * running host.
 */
export interface FrontDeskService {
  readonly mention: (
    mention: Discord.Mentioned,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

export class FrontDesk extends Context.Service<FrontDesk, {}>()(
  "alchemy-org/FrontDesk",
) {}

/**
 * The implementation: the loop, the world → loop wiring, the sealed
 * Shape. One run per thread, keyed by the channel/thread id — `send`
 * admits the thread's run on first mention and enqueues every later
 * one (the conversation moving); the Ledger dedupes DELIVERIES by
 * content, collapsing gateway redeliveries and poll re-observations.
 */
export const FrontDeskLive = Layer.effect(
  FrontDesk,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const frontDesk = yield* FrontDeskAgent;

    const mention = (mention: Discord.Mentioned) =>
      Effect.gen(function* () {
        const key = Discord.eventKey(mention);
        const { status } = yield* ledger.offer(
          "discord",
          JSON.stringify(mention),
          mention,
        );
        if (status === "duplicate") return;
        yield* frontDesk.send(mention, { key });
      });

    // ambient chatter never reaches the desk — selection IS the denial
    yield* Discord.consumeServerEvents(
      { events: [Discord.Mentioned] },
      mention,
    );

    return { mention: mention };
  }),
).pipe(Layer.provide(Layer.suspend(() => FrontDeskAgentLive)));

/** The loop behind the desk — {@link FrontDeskLive} wires the world to it. */
export class FrontDeskAgent extends AI.Agent<FrontDeskAgent>()("FrontDesk") {}

export const FrontDeskAgentLive = FrontDeskAgent.make`
  This process is the front desk of ${testAlchemy}'s Discord. A
  ${Discord.Mentioned} message is a request in natural language — a
  bug report, a feature request, a question, written the way people
  write in chat.

  Every request starts with ${SearchIssues}. A request already tracked
  is answered with ${Reply} pointing at the issue and its current
  state — most requests end here, and that answer is valuable.

  A request that is genuinely new and actionable is distilled into an
  issue with ${OpenIssue}: a title the author would recognize,
  acceptance criteria a stranger could work from, and credit to the
  thread. ${Reply} then hands the author the issue to follow. The
  issue is the handoff — the Issues process takes it from there; no
  timelines are promised and no work starts here.

  A question is answered in ${Reply} when the thread and the searched
  issues contain the answer; otherwise the honest answer is a plain
  "don't know", with an offer to open an issue if the asker thinks
  it's a gap.

  Nothing is written anywhere except issues and replies.`;
