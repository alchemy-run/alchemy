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
 * A PROCESS: its tag is {@link FrontDeskService}, and the world
 * drives the loop through the Discord event source — how mentions
 * arrive (gateway websocket, REST polling locally, interactions
 * webhook on Cloudflare) is decided entirely by which
 * `Discord.ServerEventSource` Layer is provided at composition. One
 * run per thread — a thread is a conversation, and follow-up
 * mentions steer it.
 */
import * as AI from "alchemy/AI";
import * as Discord from "alchemy/Discord";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Ledger } from "./ledger.ts";
import { testAlchemy } from "./repos.ts";
import { OpenIssue, Reply, SearchIssues } from "./tools.ts";

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

export class FrontDesk extends AI.Process<FrontDesk, FrontDeskService>()(
  "FrontDesk",
)`
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

Nothing is written anywhere except issues and replies.` {}

/**
 * The implementation: interpret the charter, wire the world to the
 * loop, expose the sealed interface. One run per thread, keyed by the
 * channel/thread id — the Ledger collapses gateway redeliveries and
 * poll re-observations to exactly one `send`; every later mention in
 * the same thread steers the conversation.
 */
export const FrontDeskLive = Layer.effect(
  FrontDesk,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const frontDesk = yield* AI.interpret(FrontDesk);

    const deliver = (mention: Discord.Mentioned) =>
      Effect.gen(function* () {
        const key = Discord.eventKey(mention);
        const { status } = yield* ledger.offer("discord", key, mention);
        yield* status === "accepted"
          ? frontDesk.send(mention, { key })
          : frontDesk.steer(key, mention);
      });

    // ambient chatter never reaches the desk — selection IS the denial
    yield* Discord.consumeServerEvents(
      { events: [Discord.Mentioned] },
      deliver,
    );

    return { mention: deliver };
  }),
);
