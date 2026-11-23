import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Comment, CommentLive } from "./Comment.tool.ts";
import { Fast, FastLive } from "./models.ts";
import { Sandbox } from "./Sandbox.ts";

const HarnessLive = Layer.mergeAll(
  FastLive,
  CommentLive,
  PiCloudflare.DurableObjectStorage,
  Pi.CodingTools.pipe(Layer.provideMerge(Sandbox)),
);

const instructions = [
  "You answer issues on a GitHub repository.",
  "The repository is cloned at /home/user/repo. Read the files that matter with your tools before you answer.",
  "When you have the answer, call the comment tool once with it. Then stop.",
].join("\n");

/** One Durable Object per issue: its conversation, its sandbox and its answers. */
export default class Issue extends Cloudflare.DurableObject<Issue>()(
  "Issue",
  Effect.gen(function* () {
    const harness = yield* Pi.Harness({ models: [Fast], tools: [AI.CodingTools, Comment] });
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      return {
        /** Start answering a new issue. Returns once the input is admitted. */
        opened: Effect.fn(function* (
          issue: { readonly number: number; readonly title: string; readonly body: string },
          deliveryId: string,
        ) {
          yield* state.storage.put("issue", issue.number);
          const conversation = yield* harness.createConversation({
            name: "issue",
            tools: [AI.Bash, AI.Read, AI.Grep, Comment],
            instructions,
          });
          yield* conversation.submit({
            type: "input",
            content: `Issue #${issue.number}: ${issue.title}\n\n${issue.body}`,
            requestId: deliveryId,
          });
        }),
        /** A person replied: add it to the conversation, running or not. */
        commented: Effect.fn(function* (text: string, deliveryId: string) {
          yield* harness.submit("issue", {
            type: "input",
            content: text,
            requestId: deliveryId,
            whenBusy: "steer",
          });
        }),
        /** What the conversation has done so far. */
        transcript: Effect.fn(function* () {
          const conversation = yield* harness.conversationByName("issue");
          const { messages } = yield* conversation.context;
          return messages.map((message) => ({
            role: message.role,
            ...(message.role === "toolResult" ? { tool: message.toolName } : {}),
            text:
              typeof message.content === "string"
                ? message.content
                : message.content
                    .map((part) =>
                      part.type === "text"
                        ? part.text
                        : part.type === "toolCall"
                          ? `${part.name}(${JSON.stringify(part.arguments)})`
                          : "",
                    )
                    .join(""),
          }));
        }),
        /** The issue is closed: its sandbox is no longer needed. */
        closed: () => harness.removeSandbox("issue"),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
