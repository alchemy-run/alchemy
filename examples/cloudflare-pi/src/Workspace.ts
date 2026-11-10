import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Fast, FastLive } from "./models.ts";
import { ArchilSandbox } from "./sandboxes/Archil.ts";
import { BoatSandbox } from "./sandboxes/Boat.ts";
import { DaytonaSandbox } from "./sandboxes/Daytona.ts";
import { E2BSandbox } from "./sandboxes/E2B.ts";
import { ModalSandbox } from "./sandboxes/Modal.ts";
import { RemoveSandbox } from "./sandboxes/RemoveSandbox.ts";

/**
 * A coding agent: Pi's own `read`, `write`, `edit` and `bash` tools, run in
 * a sandbox because a Durable Object has no file system or processes.
 *
 * Which platform the sandbox is on is the one Layer passed in. Nothing else
 * changes from one platform to the next.
 */
const workspace = <E, R>(sandbox: Layer.Layer<Pi.Sandbox | RemoveSandbox, E, R>) =>
  Effect.gen(function* () {
    const removeSandbox = yield* RemoveSandbox;
    const harness = yield* Pi.Harness({ models: [Fast], tools: [Pi.CodingTools] });

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

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
        /** Delete the conversation's sandbox. Its next tool call starts a new one. */
        remove: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          yield* removeSandbox({
            instanceId: state.id.toString(),
            conversationId: conversation.id,
          });
        }),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(FastLive, PiCloudflare.DurableObjectStorage, Pi.SandboxEnv).pipe(
        Layer.provideMerge(sandbox),
      ),
    ),
  );

export class E2BWorkspace extends Cloudflare.DurableObject<E2BWorkspace>()(
  "E2BWorkspace",
  workspace(E2BSandbox),
) {}

export class DaytonaWorkspace extends Cloudflare.DurableObject<DaytonaWorkspace>()(
  "DaytonaWorkspace",
  workspace(DaytonaSandbox),
) {}

export class ModalWorkspace extends Cloudflare.DurableObject<ModalWorkspace>()(
  "ModalWorkspace",
  workspace(ModalSandbox),
) {}

export class BoatWorkspace extends Cloudflare.DurableObject<BoatWorkspace>()(
  "BoatWorkspace",
  workspace(BoatSandbox),
) {}

export class ArchilWorkspace extends Cloudflare.DurableObject<ArchilWorkspace>()(
  "ArchilWorkspace",
  workspace(ArchilSandbox),
) {}
