import * as AI from "@alchemy.run/ai";
import * as AIBoat from "@alchemy.run/ai/Boat";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Boat from "@alchemy.run/boat";
import * as Clanka from "@alchemy.run/clanka";
import * as ClankaCloudflare from "@alchemy.run/clanka/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Prompt } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Base, Gateway } from "./infra.ts";

class Fast extends AI.Model<Fast>()("fast") {}

const FastLive = AICloudflare.Model(Fast, {
  gateway: Gateway,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 2048 },
});

/** A tool of ours, run in the Durable Object: scripts call it like clanka's own. */
class LookupCode extends AI.Tool<LookupCode>()("lookupCode", {
  description: "Look up the secret code for a word. The only way to learn a word's code.",
  parameters: Schema.Struct({ word: Schema.String }),
  success: Schema.Struct({ code: Schema.String }),
  replay: "safe",
}) {}

const LookupCodeLive = LookupCode.make(({ word }) => ({
  code: `CODE-${word.toUpperCase()}-7391`,
}));

const HarnessLive = Layer.mergeAll(
  FastLive,
  LookupCodeLive,
  ClankaCloudflare.DurableObjectStore,
  AIBoat.Sandboxes(Base),
).pipe(Layer.provideMerge(Boat.CreateSandboxHttp));

const encodePrompt = Schema.encodeUnknownEffect(Prompt.Prompt);

export default class ClankaConversations extends Cloudflare.DurableObject<ClankaConversations>()(
  "ClankaConversations",
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox(yield* Base);
    const harness = yield* Clanka.Harness({
      models: [Fast],
      tools: [LookupCode],
      // Nothing a test asks for needs the network or another agent.
      excludeTools: ["fetch", "subagent"],
    });

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      /** The conversation's sandbox as Boat lists it, if it has one. */
      const sandboxOf = Effect.fn(function* (name: string) {
        const [found] = yield* sandboxes.list({
          labels: { key: harness.conversation(name).sandboxKey },
        });
        return found;
      });

      return {
        prompt: Effect.fn(function* (name: string, text: string) {
          return { summary: yield* harness.conversation(name).prompt(text) };
        }, Effect.orDie),
        /** Every part of one prompt's output, by tag, with what scripts printed. */
        parts: Effect.fn(function* (name: string, text: string) {
          const parts = yield* Stream.runCollect(harness.conversation(name).send(text));
          return parts.map((part) => ({
            tag: part._tag,
            ...(part._tag === "ScriptOutput" ? { output: part.output } : {}),
          }));
        }, Effect.orDie),
        /** Accept a prompt and return at once. */
        submit: Effect.fn(function* (name: string, text: string, requestId: string) {
          yield* harness.conversation(name).submit(text, { requestId });
        }, Effect.orDie),
        submitted: Effect.fn(function* (name: string, requestId: string) {
          return (yield* harness.conversation(name).submitted(requestId)) ?? null;
        }, Effect.orDie),
        history: Effect.fn(function* (name: string) {
          const prompt = yield* harness.conversation(name).history;
          return (yield* encodePrompt(prompt)) as {
            readonly content: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
          };
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
        suspend: (name: string) => harness.conversation(name).suspendSandbox.pipe(Effect.orDie),
        remove: (name: string) => harness.conversation(name).removeSandbox.pipe(Effect.orDie),
        // Kill this instance; the next call builds a fresh one.
        crash: () => state.abort("crash"),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
