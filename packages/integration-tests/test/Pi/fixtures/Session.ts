import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Gateway, Notes } from "./infra.ts";
import { Fast } from "./models.ts";
import { Add, AddLive } from "./tools.ts";

const ModelsLive = Layer.unwrap(
  Effect.map(Cloudflare.AI.QueryGateway(Gateway), (gateway) =>
    Fast.layer(
      gateway.model({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        parameters: { temperature: 0, maxTokens: 1024 },
      }),
    ),
  ),
);

const HarnessLive = Layer.mergeAll(
  ModelsLive,
  AddLive,
  PiCloudflare.DurableObjectStorage,
  Pi.NoEnv,
  Cloudflare.KV.ReadWriteNamespaceBinding,
).pipe(Layer.provideMerge(Cloudflare.AI.QueryGatewayBinding));

export default class PiSession extends Cloudflare.DurableObject<PiSession>()(
  "PiSession",
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

    const harness = yield* Pi.Harness({ models: [Fast], tools: [Add, SaveNote] });

    return Effect.gen(function* () {
      return {
        create: Effect.fn(function* (name: string, tools: ReadonlyArray<"add" | "save_note">) {
          const conversation = yield* harness.createConversation({
            name,
            tools: tools.map((tool) => (tool === "add" ? Add : SaveNote)),
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
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
