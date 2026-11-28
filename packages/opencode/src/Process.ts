import {
  HarnessError,
  makeHarness,
  type Engine,
  type EngineSession,
  type Harness as AiHarness,
  type SendOptions,
  type SessionEvent,
} from "@alchemy.run/ai/Harness";
import type { AnyModel } from "@alchemy.run/ai/Model";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { NotOnHarness, OpenCodeError } from "./Errors.ts";
import { Harness } from "./Harness.ts";
import type { Storage } from "./Storage.ts";
import type { Enabled, Listed, ToolRef } from "./Tool.ts";

const failed = (error: OpenCodeError | NotOnHarness) =>
  new HarnessError({
    message:
      error._tag === "NotOnHarness"
        ? `The ${error.kind} ${error.missing} is not one this process mentions.`
        : error.message,
    cause: error,
  });

/**
 * Runs processes on OpenCode: provides `AI.Harness`. OpenCode runs in the
 * instance that hosts the processes, on its `OpenCode.Storage`; each
 * session of a process is one OpenCode session.
 *
 * **Example:** Processes on OpenCode in a Durable Object
 * ```typescript
 * export const Live = EngineerLive.pipe(
 *   Layer.provide(
 *     Layer.mergeAll(
 *       OpenCode.HarnessLive,
 *       OpenCodeCloudflare.DurableObjectStorage,
 *       OpenCode.CodingTools,
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
  "opencode",
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
        toolName: (tool) => harness.toolName(tool as ToolRef),
        session: (name, session): EngineSession => {
          const opencode = harness.session(name);
          const exists = Effect.mapError(opencode.exists, failed);
          /** A new session starts on the process's model; a started one keeps its own. */
          const optionsOf = (sent: SendOptions | undefined) =>
            Effect.map(exists, (started) => {
              const model = sent?.model ?? (started ? undefined : session.model);
              return {
                tools: session.tools as ReadonlyArray<Enabled>,
                instructions: session.instructions,
                ...(model === undefined ? {} : { model }),
                // OpenCode's message ids are one space for every session of
                // an instance, so a request's id is scoped to its session.
                ...(sent?.requestId === undefined
                  ? {}
                  : { requestId: `${name}/${sent.requestId}` }),
              };
            });
          const whenStarted = <A>(effect: Effect.Effect<A, OpenCodeError, any>, otherwise: A) =>
            Effect.flatMap(exists, (started) =>
              started ? Effect.mapError(effect, failed) : Effect.succeed(otherwise),
            );
          return {
            exists,
            open: (opened) =>
              Effect.mapError(opencode.open(opened?.model ?? session.model), failed),
            send: (text, sent) =>
              Effect.flatMap(optionsOf(sent), (options) =>
                Effect.mapError(opencode.submit(text, options), failed),
              ),
            steer: (text, sent) =>
              Effect.flatMap(optionsOf(sent), (options) =>
                Effect.mapError(opencode.submit(text, { ...options, delivery: "steer" }), failed),
              ),
            withdraw: (id) => whenStarted(opencode.withdraw(id), undefined),
            prompt: (text, sent) =>
              Effect.flatMap(optionsOf(sent), (options) =>
                opencode.prompt(text, options).pipe(
                  Effect.map((reply) => ({ text: reply.text })),
                  Effect.mapError(failed),
                ),
              ),
            interrupt: whenStarted(opencode.abort, undefined),
            events: (options) =>
              Stream.unwrap(
                Effect.map(exists, (started) =>
                  started
                    ? Stream.mapError(opencode.events(options), failed)
                    : Stream.make<[SessionEvent]>({ type: "status", status: "idle", queued: [] }),
                ),
              ),
            history: (options) => whenStarted(opencode.history(options), { items: [] }),
          };
        },
      }),
    ),
);
