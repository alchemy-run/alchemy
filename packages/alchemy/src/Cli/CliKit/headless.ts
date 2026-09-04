import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { CliKit } from "./CliKit.ts";
import { NonInteractiveTerminal } from "../../Interaction.ts";
import { setNativeProgress } from "../../Util/Terminal.ts";
import type {
  CliKitCapabilities,
  CliKitOptions,
  LiveViewHandle,
  MessageOptions,
  ProgressHandle,
  ProgressOptions,
  RenderOptions,
  Screen,
  View,
} from "../components/types.ts";

const messageText = (message: string | MessageOptions): string =>
  typeof message === "string"
    ? message
    : message.detail
      ? `${message.message} ${message.detail}`
      : message.message;

const formatView = (view: View): string => {
  if (view == null || typeof view === "boolean") return "";
  if (typeof view === "string" || typeof view === "number") return String(view);
  if (Array.isArray(view)) {
    return view
      .map(formatView)
      .filter((line) => line !== "")
      .join("\n");
  }
  return "";
};

const unsupported = (operation: string) =>
  Effect.fail(
    new NonInteractiveTerminal({
      operation,
      message: `Cannot run ${operation} without an interactive terminal. Provide the equivalent command flags instead.`,
    }),
  );

/**
 * A TypeScript-only CliKit runtime for processes that cannot load JSX
 * (Node's type-stripper rejects `.tsx`). Output is append-only text;
 * prompts fail as {@link NonInteractiveTerminal}.
 */
export const makeRuntime = (
  options: CliKitOptions,
  capabilities: CliKitCapabilities,
): {
  readonly service: CliKit["Service"];
  readonly dispose: () => Promise<void>;
} => {
  const stdout = options.stdout ?? process.stdout;
  const writeLine = (line: string) => {
    if (line !== "") stdout.write(`${line}\n`);
  };

  const print = (view: View, _renderOptions?: RenderOptions) =>
    Effect.sync(() => writeLine(formatView(view)));

  const log = (message: string | MessageOptions) => print(messageText(message));

  const run = <Value>(screen: Screen<Value>) => unsupported(screen.name);

  const makeProgress = (
    initial: ProgressOptions,
  ): Effect.Effect<ProgressHandle> =>
    Effect.sync(() => {
      let current = initial;
      let closed = false;
      writeLine(initial.label);
      const settle = (message?: string) =>
        Effect.sync(() => {
          if (closed) return;
          closed = true;
          writeLine(message ?? current.label);
        });
      return {
        update: (next) =>
          Effect.sync(() => {
            if (!closed) current = next;
          }),
        succeed: (message) => settle(message),
        fail: (message) => settle(message),
        close: Effect.sync(() => {
          closed = true;
        }),
      } satisfies ProgressHandle;
    });

  const service: CliKit["Service"] = {
    terminal: capabilities,
    nativeProgress: {
      set: (state, value) =>
        Effect.sync(() => setNativeProgress(state, value, stdout)),
    },
    output: {
      print,
      format: formatView,
      render: (view) => Effect.sync(() => formatView(view)),
      info: log,
      success: log,
      warning: log,
      error: log,
    },
    prompt: {
      text: () => unsupported("text"),
      password: () => unsupported("password"),
      confirm: () => unsupported("confirm"),
      select: () => unsupported("select"),
      multiSelect: () => unsupported("multi-select"),
      cycle: () => unsupported("cycle"),
      awaitExternal: () => unsupported("await-external"),
      menu: () => unsupported("menu"),
      custom: run,
    },
    wizard: (effect) => effect,
    application: (effect) => effect,
    live: {
      progress: (initial) =>
        Effect.acquireRelease(makeProgress(initial), (handle) => handle.close),
      open: (_view) =>
        Effect.succeed({ close: Effect.void } satisfies LiveViewHandle),
    },
    task: (taskOptions, effect) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* service.live.progress(taskOptions);
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? handle.succeed()
                : Cause.hasInterruptsOnly(exit.cause)
                  ? handle.close
                  : handle.fail(),
            ),
          );
        }),
      ),
  };

  return { service, dispose: async () => {} };
};
