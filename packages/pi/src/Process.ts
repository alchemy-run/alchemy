import {
  HarnessError,
  makeHarness,
  type Engine,
  type EngineSession,
  type Harness as AiHarness,
  type SendOptions,
} from "@alchemy.run/ai/Harness";
import type { AnyModel } from "@alchemy.run/ai/Model";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { ConversationNotFound, NotOnHarness, PiError } from "./Errors.ts";
import { Harness, type Conversation, type Enabled, type Listed } from "./Harness.ts";
import type { Storage } from "./Storage.ts";

const failed = (error: PiError | NotOnHarness | ConversationNotFound) =>
  new HarnessError({
    message:
      error._tag === "NotOnHarness"
        ? `The ${error.kind} ${error.missing} is not one this process mentions.`
        : error._tag === "ConversationNotFound"
          ? `There is no session named ${error.conversationName}.`
          : error.message,
    cause: error,
  });

/**
 * Runs processes on Pi: provides `AI.Harness`. Pi runs in the instance
 * that hosts the processes, on its `Pi.Storage`; each session of a process
 * is one Pi conversation.
 *
 * **Example:** Processes on Pi in a Durable Object
 * ```typescript
 * export const Live = EngineerLive.pipe(
 *   Layer.provide(
 *     Layer.mergeAll(
 *       Pi.HarnessLive,
 *       PiCloudflare.DurableObjectStorage,
 *       Pi.CodingTools,
 *       AI.DefaultModel(Smart),
 *       SmartLive,
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides AI.Harness
 */
export const HarnessLive: Layer.Layer<AiHarness, never, Storage> = makeHarness<Storage>(
  "pi",
  (options) =>
    Effect.map(
      Harness({
        models: options.models as ReadonlyArray<AnyModel>,
        tools: options.tools as ReadonlyArray<Listed>,
      }),
      (harness): Engine => ({
        toolName: (tool) => (tool as { readonly toolName: string }).toolName,
        session: (name, session): EngineSession => {
          const found = harness.conversationByName(name).pipe(
            Effect.map((conversation): Conversation | undefined => conversation),
            Effect.catchTag("ConversationNotFound", () => Effect.succeed(undefined)),
            Effect.mapError(failed),
          );
          const settings = {
            tools: session.tools as ReadonlyArray<Enabled>,
            instructions: session.instructions,
          };
          /** The conversation, made on its first message and kept in step with the process's prose. */
          const conversationFor = (sent: SendOptions | undefined) =>
            Effect.flatMap(found, (conversation) =>
              conversation === undefined
                ? harness
                    .createConversation({
                      name,
                      ...settings,
                      model: sent?.model ?? session.model,
                    })
                    .pipe(Effect.mapError(failed))
                : conversation
                    .configure({
                      ...settings,
                      ...(sent?.model === undefined ? {} : { model: sent.model }),
                    })
                    .pipe(Effect.mapError(failed), Effect.as(conversation)),
            );
          const submit = (text: string, sent: SendOptions | undefined) =>
            Effect.flatMap(conversationFor(sent), (conversation) =>
              conversation
                .submit({
                  type: "input",
                  content: text,
                  whenBusy: "followUp",
                  ...(sent?.requestId === undefined ? {} : { requestId: sent.requestId }),
                })
                .pipe(
                  Effect.mapError(failed),
                  Effect.map((submission) => ({ conversation, submission })),
                ),
            );
          const whenStarted = <A>(
            use: (conversation: Conversation) => Effect.Effect<A, PiError, any>,
            otherwise: A,
          ) =>
            Effect.flatMap(found, (conversation) =>
              conversation === undefined
                ? Effect.succeed(otherwise)
                : Effect.mapError(use(conversation), failed),
            );
          return {
            exists: Effect.map(found, (conversation) => conversation !== undefined),
            submit: (text, sent) => Effect.asVoid(submit(text, sent)),
            prompt: (text, sent) =>
              Effect.gen(function* () {
                const { conversation, submission } = yield* submit(text, sent);
                yield* Effect.mapError(submission.wait, failed);
                const { messages } = yield* Effect.mapError(conversation.context, failed);
                const answer = messages.findLast((message) => message.role === "assistant");
                return {
                  text:
                    answer?.role === "assistant"
                      ? answer.content
                          .flatMap((part) => (part.type === "text" ? [part.text] : []))
                          .join("")
                      : "",
                };
              }),
            wait: whenStarted((conversation) => conversation.waitForIdle, undefined),
            abort: whenStarted((conversation) => conversation.abort(), undefined),
            messages: whenStarted(
              (conversation) =>
                Effect.map(
                  conversation.context,
                  ({ messages }): ReadonlyArray<unknown> => messages,
                ),
              [],
            ),
          };
        },
      }),
    ),
);
