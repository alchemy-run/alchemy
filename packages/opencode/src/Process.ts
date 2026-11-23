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
      Harness({
        models: options.models as ReadonlyArray<AnyModel>,
        tools: options.tools as ReadonlyArray<Listed>,
      }),
      (harness): Engine => ({
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
                ...(sent?.requestId === undefined ? {} : { requestId: sent.requestId }),
              };
            });
          const whenStarted = <A>(effect: Effect.Effect<A, OpenCodeError, any>, otherwise: A) =>
            Effect.flatMap(exists, (started) =>
              started ? Effect.mapError(effect, failed) : Effect.succeed(otherwise),
            );
          return {
            exists,
            submit: (text, sent) =>
              Effect.flatMap(optionsOf(sent), (options) =>
                Effect.mapError(opencode.submit(text, options), failed),
              ),
            prompt: (text, sent) =>
              Effect.flatMap(optionsOf(sent), (options) =>
                opencode.prompt(text, options).pipe(
                  Effect.map((reply) => ({ text: reply.text })),
                  Effect.mapError(failed),
                ),
              ),
            wait: whenStarted(opencode.wait, undefined),
            abort: whenStarted(opencode.abort, undefined),
            messages: whenStarted(
              opencode.messages as Effect.Effect<ReadonlyArray<unknown>, OpenCodeError, any>,
              [],
            ),
          };
        },
      }),
    ),
);
