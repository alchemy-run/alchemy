import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";

/**
 * How the workflow engines store what a run produces as JSON: step and signal
 * exits, payloads, and a workflow's own result.
 *
 * @internal
 */

const ExitJson = Schema.toCodecJson(Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Defect()));

/**
 * Activity and deferred exits arrive with their values already encoded; a
 * void value is stored as null, since undefined isn't JSON.
 */
export const encodeExit = (exit: Exit.Exit<unknown, unknown>) =>
  Schema.encodeEffect(ExitJson)(Exit.map(exit, (value) => value ?? null)).pipe(
    Effect.map(JSON.stringify),
    Effect.orDie,
  );

export const decodeExit = (text: string) =>
  Schema.decodeEffect(ExitJson)(JSON.parse(text)).pipe(Effect.orDie);

export const payloadCodec = (workflow: Workflow.AnyWithProps) =>
  Schema.toCodecJson(workflow.payloadSchema) as unknown as Schema.Codec<unknown, unknown>;

const resultCodec = (workflow: Workflow.AnyWithProps) =>
  Schema.toCodecJson(
    Schema.Exit(workflow.successSchema, workflow.errorSchema, Schema.Defect()),
  ) as unknown as Schema.Codec<Exit.Exit<unknown, unknown>, unknown>;

/** A workflow's own result is stored through its success and error schemas. */
export const encodeResult = (workflow: Workflow.AnyWithProps, exit: Exit.Exit<unknown, unknown>) =>
  Schema.encodeEffect(resultCodec(workflow))(exit).pipe(Effect.map(JSON.stringify), Effect.orDie);

export const decodeResult = (workflow: Workflow.AnyWithProps, text: string) =>
  Schema.decodeEffect(resultCodec(workflow))(JSON.parse(text)).pipe(
    Effect.map((exit) => new Workflow.Complete({ exit })),
    Effect.orDie,
  );
