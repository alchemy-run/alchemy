import * as AI from "@alchemy.run/ai";
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

/**
 * A coding agent: the coding tools (`AI.CodingTools`) as Pi implements them, run in
 * a sandbox because a Durable Object has no file system or processes.
 *
 * Which platform the sandbox is on is the one Layer passed in. Nothing else
 * changes from one platform to the next.
 */
const workspace = <E, R>(sandbox: Layer.Layer<AI.Sandboxes, E, R>) =>
  Effect.gen(function* () {
    const harness = yield* Pi.Harness({ models: [Fast], tools: [AI.CodingTools] });

    return Effect.gen(function* () {
      return {
        create: Effect.fn(function* (name: string) {
          const conversation = yield* harness.createConversation({
            name,
            tools: [AI.Read, AI.Write, AI.Bash],
            instructions: "You work in a Linux sandbox. Use your tools to do what the user asks.",
          });
          return conversation.id;
        }),
        prompt: Effect.fn(function* (name: string, text: string, requestId: string) {
          const submission = yield* harness.submit(name, {
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
        /** Stop the conversation's sandbox, keeping its files. Its next tool call resumes it. */
        suspend: (name: string) => harness.suspendSandbox(name),
        /** Delete the conversation's sandbox. Its next tool call starts a new one. */
        remove: (name: string) => harness.removeSandbox(name),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FastLive,
        PiCloudflare.DurableObjectStorage,
        Pi.CodingTools.pipe(Layer.provideMerge(sandbox)),
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
