import * as AI from "@alchemy.run/ai";
import * as AIBoat from "@alchemy.run/ai/Boat";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as YieldedAgent from "@alchemy.run/yielded-agent";
import * as YieldedCloudflare from "@alchemy.run/yielded-agent/Cloudflare";
import { Prompt } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Assistant, Clerk, Patient } from "./agents.ts";
import { Base, Gateway } from "./infra.ts";
import {
  LookupCode,
  LookupCodeLive,
  ReadFile,
  ReadFileLive,
  SlowCode,
  SlowCodeLive,
  Withdraw,
  WithdrawLive,
  WriteFile,
  WriteFileLive,
} from "./tools.ts";

class Fast extends AI.Model<Fast>()("fast") {}

const FastLive = AICloudflare.Model(Fast, {
  gateway: Gateway,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

const HarnessLive = Layer.mergeAll(
  FastLive,
  LookupCodeLive,
  SlowCodeLive,
  WithdrawLive,
  Layer.mergeAll(WriteFileLive, ReadFileLive).pipe(Layer.provideMerge(AIBoat.Sandboxes(Base))),
  YieldedCloudflare.DurableObjectHistory,
).pipe(Layer.provideMerge(Boat.CreateSandboxHttp));

const encodePrompt = Schema.encodeUnknownEffect(Prompt.Prompt);

export default class YieldedThreads extends Cloudflare.DurableObject<YieldedThreads>()(
  "YieldedThreads",
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox(yield* Base);
    const harness = yield* YieldedAgent.Harness({
      models: [Fast],
      tools: [LookupCode, Withdraw, WriteFile, ReadFile, SlowCode],
      agents: [Patient],
    });

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        ask: Effect.fn(function* (thread: string, text: string) {
          const result = yield* harness.run(Assistant, text, { thread });
          return { output: result.output, threadId: String(result.threadId) };
        }, Effect.orDie),
        file: Effect.fn(function* (thread: string, text: string) {
          const result = yield* harness.run(Clerk, text, { thread });
          return { output: result.output };
        }, Effect.orDie),
        /** Every event of one run, by tag, with what each tool call returned. */
        events: Effect.fn(function* (thread: string, text: string) {
          const events = yield* Stream.runCollect(harness.stream(Assistant, text, { thread }));
          return events.map((event) => ({
            tag: event._tag,
            ...(event._tag === "ToolCallSucceeded" || event._tag === "ToolCallFailed"
              ? { tool: event.toolName, result: JSON.stringify(event) }
              : {}),
          }));
        }, Effect.orDie),
        history: Effect.fn(function* (thread: string) {
          return (yield* encodePrompt(yield* harness.history(thread)).pipe(Effect.orDie)) as {
            readonly content: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
          };
        }),
        /** The Thread's sandbox as Boat lists it: `running`, `paused`, or `null`. */
        sandboxState: Effect.fn(function* (thread: string) {
          const [found] = yield* sandboxes.list({ labels: { key: harness.sandboxKey(thread) } });
          if (found === undefined) return null;
          return found.state === "archiving" || found.state === "archived" ? "paused" : "running";
        }),
        /** Accept a run and return at once. */
        submit: Effect.fn(function* (thread: string, text: string, requestId: string) {
          yield* harness.submit(Patient, text, { thread, requestId });
        }, Effect.orDie),
        submitted: Effect.fn(function* (requestId: string) {
          const run = yield* harness.submitted(Patient, requestId);
          if (run === undefined) return null;
          return run.status === "done"
            ? { status: run.status, output: String(run.output) }
            : run.status === "failed"
              ? { status: run.status, message: run.message }
              : { status: run.status };
        }, Effect.orDie),
        suspend: (thread: string) => harness.suspendSandbox(thread),
        remove: (thread: string) => harness.removeSandbox(thread),
        // Kill this instance; the next call builds a fresh one.
        crash: () => state.abort("crash"),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
