import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as OpenCode from "@alchemy.run/opencode";
import * as OpenCodeCloudflare from "@alchemy.run/opencode/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Fast, FastLive } from "./models.ts";
import { Repo } from "./Repo.ts";
import { Sandbox } from "./Sandbox.ts";
import { MARKER, SearchIssues, SearchIssuesLive } from "./tools.ts";

const HarnessLive = Layer.mergeAll(
  FastLive,
  SearchIssuesLive,
  Sandbox,
  OpenCode.CodingTools,
  OpenCodeCloudflare.DurableObjectInstance,
  GitHub.CreateIssueCommentHttp,
);

const instructions = [
  "You answer issues on a GitHub repository, which is your working directory.",
  "Read the files that matter with your tools before you answer.",
  "Your answer is posted on the issue as a comment, so write it in Markdown and keep it short.",
].join("\n");

/** One Durable Object per issue: its OpenCode session, its sandbox and its answers. */
export default class Issue extends Cloudflare.DurableObject<Issue>()(
  "Issue",
  Effect.gen(function* () {
    const harness = yield* OpenCode.Harness({
      models: [Fast],
      tools: [AI.CodingTools, SearchIssues],
      cwd: "/home/user/repo",
    });
    const createComment = yield* GitHub.CreateIssueComment(yield* Repo);

    return Effect.gen(function* () {
      const session = harness.session("issue", {
        tools: [AI.Bash, AI.Read, AI.Grep, SearchIssues],
        instructions,
      });

      // A prompt runs for minutes, so it runs from the object's alarm and not
      // inside the webhook's request.
      const answer = yield* Alchemy.makeCallback(
        "answer",
        Effect.fn(function* (job: { issue: number; text: string; deliveryId: string }) {
          const reply = yield* session.prompt(job.text, { requestId: job.deliveryId });
          yield* createComment({
            issue_number: job.issue,
            body: `${reply.text}\n\n${MARKER}`,
          });
        }, Effect.orDie),
      );

      return {
        /** Answer an issue or a reply on it. Returns once the job is stored. */
        ask: Effect.fn(function* (issue: number, text: string, deliveryId: string) {
          yield* answer.schedule(deliveryId, {
            after: 0,
            payload: { issue, text, deliveryId },
          });
        }),
        /** Every tool call the session made. */
        toolCalls: Effect.fn(function* () {
          const messages = yield* session.messages;
          return messages.flatMap((message) =>
            message.type === "assistant"
              ? (message as OpenCode.AssistantMessage).content.flatMap((content) =>
                  content.type === "tool"
                    ? [
                        {
                          tool: content.name,
                          status: content.state?.status,
                          input: content.state?.input,
                        },
                      ]
                    : [],
                )
              : [],
          );
        }),
        /** The issue is closed: its sandbox is no longer needed. */
        closed: () => session.removeSandbox,
      };
    }).pipe(Effect.provide(Cloudflare.DurableObjectCallbacks));
  }).pipe(Effect.provide(HarnessLive)),
) {}
