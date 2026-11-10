import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Greeting, Guard } from "./extensions.ts";
import { Fast, FastLive } from "./models.ts";
import { Notes } from "./Notes.ts";
import { Add, AddLive } from "./tools.ts";

/** Everything the harness needs: its model, its tools, where scripts run, and its storage. */
const HarnessLive = Layer.mergeAll(
  FastLive,
  AddLive,
  Pi.CodeModeAsync.pipe(Layer.provide(PiCloudflare.EvalInline())),
  PiCloudflare.DurableObjectStorage,
  Pi.NoEnv,
  Cloudflare.KV.ReadWriteNamespaceBinding,
);

type ToolName = "add" | "save_note";

/** One user's conversations. Each lives in this Durable Object's SQLite. */
export default class Session extends Cloudflare.DurableObject<Session>()(
  "Session",
  Effect.gen(function* () {
    const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);

    // An inline tool, closing over a binding resolved in this scope.
    const SaveNote = Pi.Tool(
      "save_note",
      {
        description:
          "Save a note under a key. Use it whenever the user asks you to remember something.",
        parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
      },
      Effect.fn(function* ({ key, text }) {
        yield* notes.put(key, text).pipe(Effect.orDie);
      }),
    );

    const harness = yield* Pi.Harness({
      models: [Fast],
      tools: [Add, SaveNote],
      extensions: [Guard, Greeting, Pi.CodeMode],
    });

    const toolOf = (name: ToolName) => (name === "add" ? Add : SaveNote);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      return {
        /** Create a conversation; creating it again by name returns the same one. */
        create: Effect.fn(function* (name: string, tools: ReadonlyArray<ToolName>) {
          const conversation = yield* harness.createConversation({
            name,
            tools: tools.map(toolOf),
            instructions: "You are terse. Use your tools whenever they apply.",
          });
          return conversation.id;
        }),
        /** Send an input and wait for its answer. The `requestId` makes it exactly-once. */
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
        /** Send an input without waiting for its answer. */
        start: Effect.fn(function* (name: string, text: string, requestId: string) {
          const conversation = yield* harness.conversationByName(name);
          const submission = yield* conversation.submit({
            type: "input",
            content: text,
            requestId,
          });
          return submission.id;
        }),
        /** Kill this instance mid-run. The harness's alarm builds a new one and resumes. */
        crash: () => state.abort("crash"),
        disableTool: Effect.fn(function* (name: string, tool: ToolName) {
          const conversation = yield* harness.conversationByName(name);
          yield* conversation.configure({ tools: { remove: [toolOf(tool)] } });
        }),
        enableTool: Effect.fn(function* (name: string, tool: ToolName) {
          const conversation = yield* harness.conversationByName(name);
          yield* conversation.configure({ tools: { add: [toolOf(tool)] } });
        }),
        /** Let the conversation write programs that call its tools. */
        enableCodeMode: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          yield* conversation.configure({ extensions: { add: [Pi.CodeMode] } });
        }),
        /** Offer the conversation the greeting skill. */
        addSkill: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          yield* conversation.configure({ extensions: { add: [Greeting] } });
        }),
        /** The names of the tools the conversation may call now. */
        tools: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          const agent = yield* conversation.agent;
          return agent.tools.map((tool) => tool.name);
        }),
        /** What the model sees next: every message, as plain text. */
        messages: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          const { messages } = yield* conversation.context;
          return messages.map((message) => ({
            role: message.role,
            tool: message.role === "toolResult" ? message.toolName : undefined,
            isError: message.role === "toolResult" ? message.isError : undefined,
            text:
              typeof message.content === "string"
                ? message.content
                : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          }));
        }),
        list: () => harness.listConversations,
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
