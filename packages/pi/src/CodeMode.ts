import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import type { Extension as PiExtension } from "@earendil-works/pi-durable";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PiError } from "./Errors.ts";
import type { AnyExtension } from "./Extension.ts";
import { fromPi } from "./internal/promise.ts";

const ExtensionTypeId = "~alchemy/Pi/Extension" as const;

/**
 * Where code-mode scripts run: a deterministic JavaScript sandbox, so a
 * script cut off by a crash replays from its journal of tool results.
 * Built when an instance first opens its harness.
 */
export class Eval extends Context.Service<
  Eval,
  { readonly sandbox: Effect.Effect<CodemodeSandboxBase, PiError, RuntimeContext> }
>()("Pi.Eval") {}

/**
 * How the model writes code-mode programs: the tool it is offered and the
 * declarations it programs against. Built over an {@link Eval}.
 */
export class CodeModeConvention extends Context.Service<
  CodeModeConvention,
  { readonly extension: Effect.Effect<PiExtension, PiError, RuntimeContext> }
>()("Pi.CodeModeConvention") {}

export interface CodeModeExtension extends AnyExtension {
  readonly [ExtensionTypeId]: "codemode";
  readonly "~requires": CodeModeConvention;
}

/**
 * Code mode: the model writes a JavaScript program that calls the
 * conversation's tools (`await tools.read({ path })`), and only the
 * program's output reaches it. Select it like any extension; provide a
 * convention (`Pi.CodeModeAsync`) over a runtime (`Pi.EvalQuickJS`,
 * `PiCloudflare.EvalInline`).
 */
export const CodeMode: CodeModeExtension = {
  [ExtensionTypeId]: "codemode",
  key: "Pi.CodeMode",
  extensionName: "codemode",
  spec: {},
  impl: undefined,
  hasImpl: false,
  "~requires": undefined as never,
};

/** The name of the tool code mode adds. */
export const CODEMODE_TOOL = "codemode";

/**
 * Pi's own convention: `await tools.<name>(args)`, with TypeScript
 * declarations of every tool (typed by each tool's `success` schema).
 *
 * @layer
 * @provides Pi.CodeModeConvention
 */
export const CodeModeAsync: Layer.Layer<CodeModeConvention, never, Eval> = Layer.effect(
  CodeModeConvention,
  Effect.map(Effect.service(Eval), (evaluator) => ({
    extension: Effect.gen(function* () {
      const sandbox = yield* evaluator.sandbox;
      const { createCodemodeExtension } = yield* fromPi(
        () => import("@earendil-works/pi-durable/codemode"),
      );
      return createCodemodeExtension({ sandbox }) as PiExtension;
    }),
  })),
);

/**
 * Run scripts in QuickJS on a worker thread of this process. Needs Node
 * or Bun (a Fly Machine, an ECS task, a container).
 *
 * @layer
 * @provides Pi.Eval
 */
export const EvalQuickJS = (
  options: { readonly timeoutMs?: number; readonly memoryLimitBytes?: number } = {},
): Layer.Layer<Eval> =>
  Layer.succeed(Eval, {
    sandbox: fromPi(async () => {
      const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
      return new CodemodeSandbox(options);
    }),
  });

export const isCodeMode = (extension: AnyExtension): extension is CodeModeExtension =>
  extension[ExtensionTypeId] === "codemode";

export { PiError };
