import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { NonInteractiveTerminal } from "./errors.ts";
import type {
  ConfirmOptions,
  CycleSelectOptions,
  AwaitExternalOptions,
  AlertOptions,
  MessageOptions,
  InteractionError,
  LiveViewHandle,
  LiveViewOptions,
  MenuOptions,
  MultiSelectOptions,
  PasswordInputOptions,
  ProgressHandle,
  ProgressOptions,
  RenderOptions,
  Screen,
  SelectOptions,
  CliKitCapabilities,
  TextInputOptions,
  View,
} from "./types.ts";

export interface CliKitService {
  readonly terminal: CliKitCapabilities;

  readonly output: {
    /** Append a completed layout to terminal scrollback/output. */
    readonly print: (view: View) => Effect.Effect<void>;

    /** Render a layout without writing it. Useful for help, logs and snapshots. */
    readonly format: (view: View, options?: RenderOptions) => string;

    /** Effect form of `format`, useful when composing CLI programs. */
    readonly render: (
      view: View,
      options?: RenderOptions,
    ) => Effect.Effect<string>;

    /** Append an arbitrary visual layout. Prefer the semantic methods for logs. */
    readonly info: (message: string | MessageOptions) => Effect.Effect<void>;
    readonly success: (message: string | MessageOptions) => Effect.Effect<void>;
    readonly warning: (message: string | MessageOptions) => Effect.Effect<void>;
    readonly error: (message: string | MessageOptions) => Effect.Effect<void>;
    readonly alert: (options: AlertOptions) => Effect.Effect<void>;
    readonly section: <A, E, R>(
      title: string,
      body: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  };

  readonly prompt: {
    readonly text: (
      options: TextInputOptions,
    ) => Effect.Effect<string, InteractionError>;
    readonly password: (
      options: PasswordInputOptions,
    ) => Effect.Effect<string, InteractionError>;
    readonly confirm: (
      options: ConfirmOptions,
    ) => Effect.Effect<boolean, InteractionError>;
    readonly select: <Value>(
      options: SelectOptions<Value>,
    ) => Effect.Effect<Value, InteractionError>;
    readonly multiSelect: <Value>(
      options: MultiSelectOptions<Value>,
    ) => Effect.Effect<ReadonlyArray<Value>, InteractionError>;
    readonly cycle: <State>(
      options: CycleSelectOptions<State>,
    ) => Effect.Effect<ReadonlyArray<State>, InteractionError>;
    readonly awaitExternal: (
      options: AwaitExternalOptions,
    ) => Effect.Effect<string, InteractionError>;

    /**
     * Display an application menu. Each invocation replaces the current app
     * flow, so looping back to a menu clears any prompts shown since the last
     * selection.
     */
    readonly menu: <Value>(
      options: MenuOptions<Value>,
    ) => Effect.Effect<Value, InteractionError>;

    /** Run an arbitrary interactive screen in the service's single live region. */
    readonly custom: <Value>(
      screen: Screen<Value>,
    ) => Effect.Effect<Value, InteractionError>;
  };

  /** Run a sequence of prompts as one owned interaction. */
  readonly wizard: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NonInteractiveTerminal, R>;

  /**
   * Keep one renderer alive while an Effect drives menus, screens and prompt
   * flows. The application is cleared and the renderer exits when it settles.
   */
  readonly application: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NonInteractiveTerminal, R>;

  readonly live: {
    /** Add a mutable row to the live region. The handle is idempotent. */
    readonly progress: (
      options: ProgressOptions,
    ) => Effect.Effect<ProgressHandle>;
    /** Mount a mutable arbitrary layout in the service-owned live region. */
    readonly open: (
      view: View,
      options?: LiveViewOptions,
    ) => Effect.Effect<LiveViewHandle>;
  };

  /** Run work behind a progress row and collapse it to a final status line. */
  readonly task: <A, E, R>(
    options: ProgressOptions,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

const unavailable = () => Effect.die("CliKit service was not provided");

const unavailableService: CliKitService = {
  terminal: {
    input: false,
    columns: 80,
    rows: 24,
    colors: false,
    unicode: false,
  },
  output: {
    print: unavailable,
    format: () => {
      throw new Error("CliKit service was not provided");
    },
    render: unavailable,
    info: unavailable,
    success: unavailable,
    warning: unavailable,
    error: unavailable,
    alert: unavailable,
    section: unavailable,
  },
  prompt: {
    text: unavailable,
    password: unavailable,
    confirm: unavailable,
    select: unavailable,
    multiSelect: unavailable,
    cycle: unavailable,
    awaitExternal: unavailable,
    menu: unavailable,
    custom: unavailable,
  },
  wizard: unavailable,
  application: unavailable,
  live: { progress: unavailable, open: unavailable },
  task: unavailable,
};

/** The sole injected owner of terminal rendering and input for a CLI process. */
export const CliKit = Context.Reference<CliKitService>("Alchemy::CliKit", {
  defaultValue: () => unavailableService,
});

const ApplicationPresentation = Context.Reference<"inline" | "alternate">(
  "Alchemy::CliKit/ApplicationPresentation",
  { defaultValue: () => "inline" },
);

/** Pipeable presentation modifiers for {@link CliKitService.application}. */
export const Application = {
  alternate: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ApplicationPresentation, "alternate" as const),
    ),
};

export const applicationPresentation = ApplicationPresentation;
