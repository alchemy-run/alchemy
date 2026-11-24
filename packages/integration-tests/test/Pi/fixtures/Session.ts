import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Guard } from "./extensions.ts";
import { Gateway, Notes } from "./infra.ts";
import { Fast } from "./models.ts";
import { Add, AddLive, codemodeSection, GlobLive, Withdraw, WithdrawLive } from "./tools.ts";

const ModelsLive = AICloudflare.Model(Fast, {
  gateway: Gateway,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

const HarnessLive = Layer.mergeAll(
  ModelsLive,
  AddLive,
  WithdrawLive,
  GlobLive,
  AI.CodeModeAsync.pipe(Layer.provide(AICloudflare.EvalQuickJS())),
  PiCloudflare.DurableObjectStorage,
  Cloudflare.KV.ReadWriteNamespaceBinding,
);

/** The tools a program may call. */
const Programs = AI.CodeMode(Add, Withdraw);

export default class PiSession extends Cloudflare.DurableObject<PiSession>()(
  "PiSession",
  Effect.gen(function* () {
    // An inline tool. Its Effect binds what the tool uses.
    const SaveNote = yield* AI.Tool(
      "save_note",
      {
        description:
          "Save a note under a key. Use it whenever the user asks you to remember something.",
        parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
        success: Schema.Void,
      },
      Effect.gen(function* () {
        const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);
        return Effect.fn(function* ({
          key,
          text,
        }: {
          readonly key: string;
          readonly text: string;
        }) {
          yield* notes.put(key, text).pipe(Effect.orDie);
        });
      }),
    );

    const harness = yield* Pi.Harness({
      models: [Fast],
      // `add` and `withdraw` are offered both ways: as direct calls, and from programs.
      tools: [Add, SaveNote, Withdraw, AI.Glob, Programs],
      extensions: [Guard],
    });

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        // Admit an input without waiting for its answer.
        start: Effect.fn(function* (name: string, text: string, requestId: string) {
          const conversation = yield* harness.conversationByName(name);
          const submission = yield* conversation.submit({
            type: "input",
            content: text,
            requestId,
          });
          return submission.id;
        }),
        // Kill this instance; the next call or the alarm builds a fresh one.
        crash: () => state.abort("crash"),
        // Whether the newest message is an answer (an assistant message with text).
        answered: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          const { messages } = yield* conversation.context;
          const last = messages.at(-1);
          return (
            last?.role === "assistant" &&
            last.content.some((part) => part.type === "text" && part.text.length > 0)
          );
        }),
        create: Effect.fn(function* (
          name: string,
          tools: ReadonlyArray<"add" | "save_note" | "withdraw" | "glob">,
        ) {
          const conversation = yield* harness.createConversation({
            name,
            tools: tools.map((tool) =>
              tool === "add"
                ? Add
                : tool === "withdraw"
                  ? Withdraw
                  : tool === "glob"
                    ? AI.Glob
                    : SaveNote,
            ),
            instructions: "You are terse. Use your tools whenever they apply.",
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
          const settled = yield* submission.wait;
          return { status: settled.status, submission: submission.id };
        }),
        disable: Effect.fn(function* (name: string, tool: "add" | "save_note") {
          const conversation = yield* harness.conversationByName(name);
          yield* conversation.configure({ tools: { remove: [tool === "add" ? Add : SaveNote] } });
        }),
        enable: Effect.fn(function* (name: string, tool: "add" | "save_note") {
          const conversation = yield* harness.conversationByName(name);
          yield* conversation.configure({ tools: { add: [tool === "add" ? Add : SaveNote] } });
        }),
        addCodeMode: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          yield* conversation.configure({ tools: { add: [Programs] } });
        }),
        /** The tools the model is offered, by name. */
        offered: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          return (yield* conversation.agent).tools.map((tool) => tool.name).sort();
        }),
        /** The code mode section of the system prompt the conversation was last sent. */
        section: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          return codemodeSection((yield* conversation.context).messages) ?? null;
        }),
        toolResults: Effect.fn(function* (name: string) {
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
        tools: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          const agent = yield* conversation.agent;
          return agent.tools.map((tool) => tool.name);
        }),
        transcript: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          const { messages } = yield* conversation.context;
          return JSON.parse(JSON.stringify(messages)) as unknown;
        }),
        list: () => harness.listConversations,
        resume: Effect.fn(function* () {
          const raw = yield* harness.raw;
          raw.resume();
          yield* harness.waitForIdle.pipe(Effect.timeoutOption("20 seconds"));
        }),
        inspect: Effect.fn(function* (name: string) {
          const inspection = yield* harness.inspect;
          const raw = yield* harness.raw;
          const conversation = yield* harness.conversationByName(name);
          const { messages } = yield* conversation.context;
          return JSON.parse(
            JSON.stringify({
              scheduling: inspection.scheduling,
              wake: raw.wake(),
              tasks: inspection.tasks.map((task) => ({
                kind: task.record.kind,
                state: task.state,
              })),
              submissions: inspection.submissions.map((submission) => submission.status),
              messages: messages.map((message) => message.role),
            }),
          ) as unknown;
        }),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
