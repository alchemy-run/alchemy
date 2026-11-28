import {
  HarnessError,
  makeHarness,
  type Engine,
  type EngineSession,
  type Harness as AiHarness,
  type QueuedMessage,
  type SendOptions,
  type SessionEntry,
  type SessionEvent,
  type SessionItem,
} from "@alchemy.run/ai/Harness";
import type { AnyModel } from "@alchemy.run/ai/Model";
import type {
  ConversationView,
  EntryId,
  EntryRecord,
  SubmissionId,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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

/** The text of a message's content: a string, or its text parts. */
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part: { readonly type?: string; readonly text?: string }) =>
            part.type === "text" && part.text !== undefined ? [part.text] : [],
          )
          .join("")
      : "";

/** What an entry adds to the transcript. An entry the model does not read adds nothing. */
const itemsOf = (entry: EntryRecord): ReadonlyArray<SessionEntry> =>
  (entry.model ?? [])
    .flatMap((message): ReadonlyArray<SessionItem> => {
      if (message.role === "user") return [{ type: "user", text: textOf(message.content) }];
      if (message.role === "assistant") {
        return [
          {
            type: "assistant",
            text: textOf(message.content),
            toolCalls: message.content.flatMap((part) =>
              part.type === "toolCall"
                ? [{ id: part.id, name: part.name, input: part.arguments }]
                : [],
            ),
          },
        ];
      }
      if (message.role === "toolResult") {
        return [
          {
            type: "tool",
            callId: message.toolCallId,
            name: message.toolName,
            output: textOf(message.content),
            isError: message.isError === true,
          },
        ];
      }
      return [];
    })
    .map((item) => ({ seq: entry.id, item }));

/** Whether a conversation is working, and what waits in its inbox. */
const statusOf = (view: ConversationView): Extract<SessionEvent, { type: "status" }> => {
  const live = view.docs["pi.live"] as { readonly run?: unknown } | undefined;
  const inbox = view.docs["pi.inbox"] as
    | {
        readonly items?: ReadonlyArray<{
          readonly id: number;
          readonly mode: string;
          readonly content?: unknown;
        }>;
      }
    | undefined;
  return {
    type: "status",
    status: live?.run === undefined ? "idle" : "working",
    queued: (inbox?.items ?? []).flatMap((item): ReadonlyArray<QueuedMessage> =>
      item.mode === "write"
        ? []
        : [
            {
              id: String(item.id),
              text: textOf(item.content),
              delivery: item.mode === "steer" ? "steer" : "queue",
            },
          ],
    ),
  };
};

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
      Effect.all([
        Harness({
          models: options.models as ReadonlyArray<AnyModel>,
          tools: options.tools as ReadonlyArray<Listed>,
        }),
      ]),
      ([harness]): Engine => ({
        // The values the harness gives its tool calls their state from.
        values: harness["~values"],
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
          const submit = (
            text: string,
            sent: SendOptions | undefined,
            whenBusy: "followUp" | "steer" = "followUp",
          ) =>
            Effect.flatMap(conversationFor(sent), (conversation) =>
              conversation
                .submit({
                  type: "input",
                  content: text,
                  whenBusy,
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
            // A tool call carries the conversation's id.
            open: (opened) =>
              Effect.map(conversationFor(opened), (conversation) => String(conversation.id)),
            send: (text, sent) => Effect.asVoid(submit(text, sent)),
            steer: (text, sent) => Effect.asVoid(submit(text, sent, "steer")),
            withdraw: (id) =>
              whenStarted(
                (conversation) => conversation.withdraw(Number(id) as SubmissionId),
                undefined,
              ),
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
            // Pi's abort also withdraws what is queued.
            interrupt: whenStarted((conversation) => conversation.abort(), undefined),
            events: (options) =>
              Stream.unwrap(
                Effect.map(found, (conversation) => {
                  if (conversation === undefined) {
                    return Stream.make<[SessionEvent]>({
                      type: "status",
                      status: "idle",
                      queued: [],
                    });
                  }
                  let seen = options?.after ?? 0;
                  let last = "";
                  return conversation.watch({ from: (seen + 1) as EntryId }).pipe(
                    Stream.mapEffect((view) =>
                      Effect.gen(function* () {
                        const events: Array<SessionEvent> = [];
                        const status = statusOf(view);
                        const key = JSON.stringify(status);
                        // The first event is the status. After that a change of status
                        // follows the items stored with it, so `idle` comes after the answer.
                        const changed = key !== last;
                        const first = last === "";
                        if (first) events.push(status);
                        last = key;
                        // A window that starts past what the reader has is filled from storage.
                        while (view.before !== undefined && view.before > seen) {
                          const page = yield* conversation.entries({
                            after: seen as EntryId,
                            before: (view.before + 1) as EntryId,
                            limit: 100,
                          });
                          if (page.length === 0) break;
                          for (const entry of page) {
                            for (const item of itemsOf(entry))
                              events.push({ type: "item", ...item });
                            seen = entry.id;
                          }
                        }
                        for (const entry of view.entries) {
                          if (entry.id <= seen) continue;
                          for (const item of itemsOf(entry)) events.push({ type: "item", ...item });
                          seen = entry.id;
                        }
                        if (changed && !first) events.push(status);
                        return events;
                      }),
                    ),
                    Stream.flatMap((events) => Stream.fromIterable(events)),
                    Stream.mapError(failed),
                  );
                }),
              ),
            history: (options) =>
              whenStarted(
                (conversation) =>
                  Effect.gen(function* () {
                    const take = options?.take ?? 50;
                    const descending = options?.order === "desc";
                    const entries = yield* conversation.entries({
                      limit: take,
                      order: descending ? "descending" : "ascending",
                      ...(options?.after === undefined
                        ? {}
                        : descending
                          ? { before: options.after as EntryId }
                          : { after: options.after as EntryId }),
                    });
                    const lastEntry = entries.at(-1);
                    return {
                      items: entries.flatMap(itemsOf),
                      ...(entries.length === take && lastEntry !== undefined
                        ? { next: lastEntry.id as number }
                        : {}),
                    };
                  }),
                { items: [] },
              ),
          };
        },
      }),
    ),
);
