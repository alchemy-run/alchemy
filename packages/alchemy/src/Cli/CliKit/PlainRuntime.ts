import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { NonInteractiveTerminal } from "./errors.ts";
import type { CliKitService } from "./CliKit.ts";
import type {
  CliKitCapabilities,
  CliKitOptions,
  LiveViewHandle,
  MessageOptions,
  ProgressHandle,
  ProgressOptions,
  Screen,
  View,
} from "./types.ts";

/** Extract readable content from a React view without loading React or Ink. */
const viewText = (view: View): string => {
  if (view === null || view === undefined || typeof view === "boolean") {
    return "";
  }
  if (
    typeof view === "string" ||
    typeof view === "number" ||
    typeof view === "bigint"
  ) {
    return String(view);
  }
  if (Array.isArray(view)) return view.map(viewText).join("");
  if (typeof view === "object" && "props" in view) {
    const props = view.props as { readonly children?: View };
    return viewText(props.children);
  }
  return "";
};

const messageText = (message: string | MessageOptions) =>
  typeof message === "string"
    ? message
    : `${message.message}${message.detail === undefined ? "" : ` (${message.detail})`}`;

const nonInteractive = (operation: string) =>
  Effect.fail<NonInteractiveTerminal>(
    new NonInteractiveTerminal({
      operation,
      message: `Cannot run ${operation} without an interactive terminal. Provide the equivalent command flags instead.`,
    }),
  );

export interface PlainCliKitRuntime {
  readonly service: CliKitService;
  readonly dispose: () => Promise<void>;
}

/** Append-only CliKit runtime for CI, redirected output and `--no-input`. */
export const makeRuntime = (
  options: CliKitOptions,
  capabilities: CliKitCapabilities,
): PlainCliKitRuntime => {
  const stdout = options.stdout ?? process.stdout;
  const write = (value: string) =>
    Effect.sync(() => {
      if (value !== "") stdout.write(`${value}\n`);
    });
  const print = (view: View) => write(viewText(view));
  const message = (label: string) => (value: string | MessageOptions) =>
    write(`${label}: ${messageText(value)}`);

  const progress = (initial: ProgressOptions): Effect.Effect<ProgressHandle> =>
    Effect.gen(function* () {
      let current = initial;
      let closed = false;
      yield* write(
        `${initial.label}${initial.detail === undefined ? "" : ` (${initial.detail})`}`,
      );
      const settle = (label: string, value?: string) =>
        Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          return write(`${label}: ${value ?? current.label}`);
        });
      return {
        update: (next) =>
          Effect.sync(() => {
            if (!closed) current = next;
          }),
        succeed: (value) => settle("success", value),
        fail: (value) => settle("error", value),
        close: Effect.sync(() => {
          closed = true;
        }),
      } satisfies ProgressHandle;
    });

  const service: CliKitService = {
    terminal: capabilities,
    output: {
      print,
      format: viewText,
      render: (view) => Effect.succeed(viewText(view)),
      info: message("info"),
      success: message("success"),
      warning: message("warning"),
      error: message("error"),
      alert: (alert) =>
        write(
          [alert.title, alert.message, alert.detail]
            .filter((part) => part !== undefined && part !== "")
            .join(": "),
        ),
      section: (title, body) => write(title).pipe(Effect.andThen(body)),
    },
    prompt: {
      text: () => nonInteractive("text input"),
      password: () => nonInteractive("password input"),
      confirm: () => nonInteractive("confirmation"),
      select: () => nonInteractive("selection"),
      multiSelect: () => nonInteractive("multiple selection"),
      cycle: () => nonInteractive("cycle selection"),
      awaitExternal: () => nonInteractive("external authorization"),
      menu: () => nonInteractive("menu"),
      custom: <Value>(screen: Screen<Value>) => nonInteractive(screen.name),
    },
    wizard: () => nonInteractive("wizard"),
    application: () => nonInteractive("application"),
    live: {
      progress,
      open: (initial) =>
        Effect.gen(function* () {
          let closed = false;
          yield* print(initial);
          return {
            update: (view) => (closed ? Effect.void : print(view)),
            close: Effect.sync(() => {
              closed = true;
            }),
          } satisfies LiveViewHandle;
        }),
    },
    task: (taskOptions, effect) =>
      Effect.gen(function* () {
        const handle = yield* progress(taskOptions);
        return yield* effect.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? handle.succeed() : handle.fail(),
          ),
        );
      }),
  };

  return { service, dispose: () => Promise.resolve() };
};
