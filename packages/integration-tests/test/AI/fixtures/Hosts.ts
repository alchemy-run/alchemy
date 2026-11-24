import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as OpenCode from "@alchemy.run/opencode";
import * as OpenCodeCloudflare from "@alchemy.run/opencode/Cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Adder, Operator, ProcessesLive } from "./Processes.ts";

/** What a test asks of a session. */
export interface Ask {
  readonly action: string;
  readonly text?: string;
  readonly requestId?: string;
}

/**
 * A Durable Object's methods over the processes, on whichever harness its
 * Layer provides. One object holds every session of a test run.
 */
const sessions = Effect.gen(function* () {
  const processes: Record<string, AI.ProcessClient<any>> = {
    Adder: yield* Adder,
    Operator: yield* Operator,
  };

  return Effect.succeed({
    ask: Effect.fn(function* (name: string, key: string, ask: Ask) {
      const process = processes[name];
      if (process === undefined) return undefined;
      const session = process.get(key);
      const sent = ask.requestId === undefined ? {} : { requestId: ask.requestId };
      return yield* Match.value(ask.action).pipe(
        Match.when("send", () => Effect.as(session.send(ask.text ?? "", sent), { ok: true })),
        Match.when("prompt", () => session.prompt(ask.text ?? "", sent)),
        Match.when("steer", () => Effect.as(session.steer(ask.text ?? "", sent), { ok: true })),
        // Idle with nothing queued: every message it was given has been answered.
        Match.when("wait", () =>
          session.events().pipe(
            Stream.filter(
              (event) =>
                event.type === "status" && event.status === "idle" && event.queued.length === 0,
            ),
            Stream.runHead,
            Effect.as({ ok: true }),
          ),
        ),
        Match.when("interrupt", () => Effect.as(session.interrupt, { ok: true })),
        Match.when("status", () =>
          Effect.map(Stream.runHead(session.events()), (first) => ({
            messages: JSON.stringify(Option.getOrUndefined(first)),
          })),
        ),
        Match.when("messages", () =>
          Effect.map(session.history({ take: 200 }), (page) => ({
            messages: JSON.stringify(page.items),
          })),
        ),
        Match.orElse(() => Effect.succeed(undefined)),
        Effect.orDie,
      );
    }),
  });
});

/** The processes on Pi. */
export class PiAgents extends Cloudflare.DurableObject<PiAgents>()(
  "PiAgents",
  sessions.pipe(
    Effect.provide(
      ProcessesLive.pipe(
        Layer.provide(Pi.HarnessLive),
        Layer.provide(PiCloudflare.DurableObjectStorage),
      ),
    ),
  ),
) {}

/** The same processes on OpenCode: only the harness and its storage differ. */
export class OpenCodeAgents extends Cloudflare.DurableObject<OpenCodeAgents>()(
  "OpenCodeAgents",
  sessions.pipe(
    Effect.provide(
      ProcessesLive.pipe(
        Layer.provide(OpenCode.HarnessLive),
        Layer.provide(OpenCodeCloudflare.DurableObjectStorage),
      ),
    ),
  ),
) {}

/** One object per Adder session, named by its key, serving it as `AI.SessionRpcs`. */
const served = Effect.gen(function* () {
  const adder = yield* Adder;
  const state = yield* Cloudflare.DurableObjectState;
  return Effect.sync(() => AI.SessionHandlers(adder.get(state.id.name ?? "")));
});

/** An Adder session a browser reaches, on Pi. */
export class PiSessions extends Cloudflare.RpcDurableObject<PiSessions>()(
  "PiSessions",
  { schema: AI.SessionRpcs },
  served.pipe(
    Effect.provide(
      ProcessesLive.pipe(
        Layer.provide(Pi.HarnessLive),
        Layer.provide(PiCloudflare.DurableObjectStorage),
      ),
    ),
  ),
) {}

/** The same, on OpenCode. */
export class OpenCodeSessions extends Cloudflare.RpcDurableObject<OpenCodeSessions>()(
  "OpenCodeSessions",
  { schema: AI.SessionRpcs },
  served.pipe(
    Effect.provide(
      ProcessesLive.pipe(
        Layer.provide(OpenCode.HarnessLive),
        Layer.provide(OpenCodeCloudflare.DurableObjectStorage),
      ),
    ),
  ),
) {}
