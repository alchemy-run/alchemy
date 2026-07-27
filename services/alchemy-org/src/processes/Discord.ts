/**
 * The DiscordDesk process — the org's front desk on Discord. A mention
 * is a request in natural language; this process turns it into the
 * org's durable artifacts (an issue, a link to prior art) and answers
 * in the thread it was asked in.
 *
 * It deliberately owns NO engineering tools: work happens because an
 * issue exists and the Issues process picks it up — never because a
 * chat message shortcut-ed the process. Note it never references
 * ${Issues} either: the handoff artifact is the issue itself.
 *
 * SEALED by construction: {@link DiscordDesk} is a plain
 * `Context.Service` resolving to {@link DiscordDeskService}, and the
 * world drives the loop through the Discord event source — how
 * mentions arrive (gateway websocket, REST polling locally,
 * interactions webhook on Cloudflare) is decided entirely by which
 * `Discord.ServerEventSource` Layer is provided at composition. One
 * run per thread — a thread is a conversation, and follow-up
 * mentions steer it.
 */
import * as Discord from "alchemy/Discord";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FrontDesk,
  FrontDeskLive,
} from "../agents/FrontDesk.ts";
import { Ledger } from "../Ledger.ts";

/**
 * What the org may ask of the DiscordDesk from code. `mention` is a
 * manual injection door (tests, a bespoke substrate); the normal
 * path is the event source wired inside {@link DiscordDeskLive}.
 * Colored `RuntimeContext` — deliveries only happen inside the
 * running host.
 */
export interface DiscordDeskService {
  readonly mention: (
    mention: Discord.Mentioned,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

export class DiscordDesk extends Context.Service<DiscordDesk, {}>()(
  "alchemy-org/DiscordDesk",
) {}

/**
 * The implementation: the loop, the world → loop wiring, the sealed
 * Shape. One run per thread, keyed by the channel/thread id — `send`
 * admits the thread's run on first mention and enqueues every later
 * one (the conversation moving); the Ledger dedupes DELIVERIES by
 * content, collapsing gateway redeliveries and poll re-observations.
 */
export const DiscordDeskLive = Layer.effect(
  DiscordDesk,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const frontDesk = yield* FrontDesk;

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
).pipe(Layer.provide(Layer.suspend(() => FrontDeskLive)));
