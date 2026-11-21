import * as AI from "@alchemy.run/ai";
import * as AIBoat from "@alchemy.run/ai/Boat";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Nanocode from "@alchemy.run/nanocode";
import * as NanocodeCloudflare from "@alchemy.run/nanocode/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const Gateway = Cloudflare.AI.Gateway("NanocodeGateway", { collectLogs: true });

/** The snapshot every session's sandbox boots from. */
export const Base = Boat.Snapshot("NanocodeBase", { run: ["node --version"] });

class Fast extends AI.Model<Fast>()("fast") {}

const FastLive = AICloudflare.Model(Fast, {
  gateway: Gateway,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

/** A tool of ours, run in the Durable Object. */
class LookupCode extends AI.Tool<LookupCode>()("lookup_code", {
  description: "Look up the secret code for a word. The only way to learn a word's code.",
  parameters: Schema.Struct({ word: Schema.String }),
  success: Schema.Struct({ code: Schema.String }),
  replay: "safe",
}) {}

const LookupCodeLive = LookupCode.make(({ word }) => ({
  code: `CODE-${word.toUpperCase()}-7391`,
}));

/** A tool that takes a while: long enough for a test to kill the instance while it runs. */
class SlowCode extends AI.Tool<SlowCode>()("slow_code", {
  description: "Look up the slow secret code for a word. The only way to learn a word's slow code.",
  parameters: Schema.Struct({ word: Schema.String }),
  success: Schema.Struct({ code: Schema.String }),
  replay: "safe",
}) {}

const SlowCodeLive = SlowCode.make(
  Effect.fn(function* ({ word }) {
    yield* Effect.sleep("8 seconds");
    return { code: `SLOW-${word.toUpperCase()}-4242` };
  }),
);

const HarnessLive = Layer.mergeAll(
  FastLive,
  LookupCodeLive,
  SlowCodeLive,
  NanocodeCloudflare.DurableObjectHost,
  AIBoat.Sandboxes(Base),
).pipe(Layer.provideMerge(Boat.CreateSandboxHttp));

export default class NanocodeSessions extends Cloudflare.DurableObject<NanocodeSessions>()(
  "NanocodeSessions",
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox(yield* Base);
    const harness = yield* Nanocode.Harness({
      models: [Fast],
      tools: [LookupCode, SlowCode],
      instructions:
        "You are terse. Use your tools whenever they apply, then answer in one sentence.",
    });

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      /** The session's sandbox as Boat lists it, if it has one. */
      const sandboxOf = Effect.fn(function* (name: string) {
        const [found] = yield* sandboxes.list({
          labels: { key: harness.session(name).sandboxKey },
        });
        return found;
      });

      return {
        prompt: Effect.fn(function* (name: string, text: string, requestId?: string) {
          return {
            message: yield* harness
              .session(name)
              .prompt(text, requestId === undefined ? {} : { requestId }),
          };
        }, Effect.orDie),
        /** Accept a prompt and return at once. */
        submit: Effect.fn(function* (name: string, text: string, requestId: string) {
          yield* harness.session(name).submit(text, { requestId });
        }, Effect.orDie),
        submitted: Effect.fn(function* (name: string, requestId: string) {
          return (yield* harness.session(name).submitted(requestId)) ?? null;
        }, Effect.orDie),
        /** The session's log, as the types of its agent events and the tools they name. */
        events: Effect.fn(function* (name: string) {
          const events = yield* harness.session(name).events;
          return events.map(({ event }) => {
            const inner = (event as { event?: { type?: string; payload?: { tool?: string } } })
              .event;
            return {
              type: inner?.type ?? (event as { type?: string }).type ?? "",
              ...(inner?.payload?.tool === undefined ? {} : { tool: inner.payload.tool }),
            };
          });
        }, Effect.orDie),
        readFile: Effect.fn(function* (name: string, path: string) {
          const found = yield* sandboxOf(name);
          if (found === undefined) return null;
          const sandbox = yield* sandboxes.connect(found.id);
          return yield* sandbox.files.readText(path).pipe(Effect.orElseSucceed(() => null));
        }),
        /** The sandbox's state on Boat: `running`, `paused`, or `null` when it has none. */
        sandboxState: Effect.fn(function* (name: string) {
          const state = (yield* sandboxOf(name))?.state;
          if (state === undefined) return null;
          return state === "archiving" || state === "archived" ? "paused" : "running";
        }),
        suspend: (name: string) => harness.session(name).suspendSandbox.pipe(Effect.orDie),
        remove: (name: string) => harness.session(name).removeSandbox.pipe(Effect.orDie),
        // Kill this instance; the next call builds a fresh one.
        crash: () => state.abort("crash"),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
