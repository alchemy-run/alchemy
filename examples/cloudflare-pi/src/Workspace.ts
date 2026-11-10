import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Fast, FastLive } from "./models.ts";
import { Base } from "./Sandbox.ts";

/**
 * Marks a conversation's sandbox. Conversation ids repeat from one Durable
 * Object to the next, so the object's id is part of the mark.
 */
const markOf = (instanceId: string, conversationId: number) => ({
  "pi-instance": instanceId,
  "pi-conversation": String(conversationId),
});

/** One E2B sandbox per conversation, found again by its mark. */
const SandboxLive = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(Base);
    return Effect.fn(function* ({ instanceId, conversationId }) {
      const metadata = markOf(instanceId, conversationId);
      const [existing] = yield* sandboxes.list({ metadata, state: ["running", "paused"] });
      return existing
        ? yield* sandboxes.connect(existing.sandboxID)
        : yield* sandboxes.create({ metadata, timeout: 600 });
    });
  }),
);

const HarnessLive = Layer.mergeAll(FastLive, PiCloudflare.DurableObjectStorage, Pi.SandboxEnv).pipe(
  Layer.provide(SandboxLive),
  Layer.provideMerge(E2B.CreateSandboxHttp),
);

/**
 * A coding agent: Pi's own `read`, `write`, `edit` and `bash` tools, run in
 * an E2B sandbox because a Durable Object has no file system or processes.
 */
export default class Workspace extends Cloudflare.DurableObject<Workspace>()(
  "Workspace",
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(Base);
    const harness = yield* Pi.Harness({ models: [Fast], tools: [Pi.CodingTools] });

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      /** The id of the conversation's sandbox, if it has one. */
      const sandboxIdOf = Effect.fn(function* (name: string) {
        const conversation = yield* harness.conversationByName(name);
        const [found] = yield* sandboxes.list({
          metadata: markOf(state.id.toString(), conversation.id),
          state: ["running", "paused"],
        });
        return found?.sandboxID;
      });

      return {
        create: Effect.fn(function* (name: string) {
          const conversation = yield* harness.createConversation({
            name,
            tools: [Pi.Read, Pi.Write, Pi.Bash],
            instructions: "You work in a Linux sandbox. Use your tools to do what the user asks.",
          });
          return conversation.id;
        }),
        prompt: Effect.fn(function* (name: string, text: string, requestId: string) {
          const conversation = yield* harness.conversationByName(name);
          const submission = yield* conversation.submit({
            type: "input",
            content: text,
            requestId,
          });
          return (yield* submission.wait).status;
        }),
        /** Every tool call the conversation made, and whether it failed. */
        toolCalls: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          const { messages } = yield* conversation.context;
          return messages.flatMap((message) =>
            message.role === "toolResult"
              ? [
                  {
                    tool: message.toolName,
                    isError: message.isError,
                    text: message.content
                      .map((part) => (part.type === "text" ? part.text : ""))
                      .join(""),
                  },
                ]
              : [],
          );
        }),
        /** Read a file out of the conversation's sandbox: `null` when the file or the sandbox is gone. */
        readFile: Effect.fn(function* (name: string, path: string) {
          const sandboxId = yield* sandboxIdOf(name);
          if (sandboxId === undefined) return null;
          // A sandbox killed a moment ago can still be listed.
          const sandbox = yield* sandboxes
            .connect(sandboxId)
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
          return sandbox === undefined
            ? null
            : yield* sandbox.files.readText(path).pipe(Effect.orElseSucceed(() => null));
        }),
        /** Stop the conversation's sandbox. */
        kill: Effect.fn(function* (name: string) {
          const sandboxId = yield* sandboxIdOf(name);
          if (sandboxId !== undefined) yield* sandboxes.kill(sandboxId);
        }),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
