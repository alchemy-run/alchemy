import type * as Effect from "effect/Effect";
import type { ReactNode } from "react";
import type { NonInteractiveTerminal, TerminalCancelled } from "./errors.ts";

/** A composable CLI layout. Views are inert; only CliKit renders them. */
export type View = ReactNode;

export interface CliKitCapabilities {
  /** Whether this process has usable terminal input for prompts and apps. */
  readonly input: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly colors: boolean;
  readonly unicode: boolean;
}

export interface RenderOptions {
  readonly columns?: number;
  readonly colors?: boolean;
}

export interface Choice<Value> {
  readonly value: Value;
  readonly label: string;
  /** Optional section heading shared by adjacent choices. */
  readonly group?: string;
  /** Indent the entire rendered row, including its selection indicator. */
  readonly indent?: number;
  /** Keep this row visible as the heading for following rows while scrolling. */
  readonly sticky?: boolean;
  /** Visually distinguish structural rows from ordinary choices. */
  readonly tone?: "info";
  readonly description?: string;
  readonly disabled?: boolean | string;
}

export interface MessageOptions {
  readonly message: string;
  readonly detail?: string;
}

export interface AlertOptions extends MessageOptions {
  readonly variant?: "info" | "success" | "warning" | "error";
  readonly title?: string;
}

export interface TextInputOptions {
  readonly message: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly defaultValue?: string;
  readonly validate?: (value: string) => string | Error | undefined;
}

export interface PasswordInputOptions extends Omit<
  TextInputOptions,
  "initialValue" | "defaultValue"
> {}

export interface ConfirmOptions {
  readonly message: string;
  readonly initialValue?: boolean;
}

export interface SelectOptions<Value> {
  readonly message: string;
  readonly options: ReadonlyArray<Choice<Value>>;
  readonly initialValue?: Value;
  readonly visibleCount?: number;
  /** Allow typing to filter choices by label and description. */
  readonly searchable?: boolean;
  /** Place descriptions beside labels instead of on a second line. */
  readonly descriptionPlacement?: "below" | "inline";
}

export interface MultiSelectOptions<Value> extends Omit<
  SelectOptions<Value>,
  "initialValue"
> {
  readonly initialValues?: ReadonlyArray<Value>;
  readonly required?: boolean;
  readonly searchable?: boolean;
}

export interface CycleChoice<State> {
  readonly label: string;
  readonly description?: string;
  readonly states: ReadonlyArray<{
    readonly value: State;
    readonly label?: string;
    readonly icon?: string;
    readonly variant?:
      | "neutral"
      | "accent"
      | "info"
      | "success"
      | "warning"
      | "error";
  }>;
}

export interface CycleSelectOptions<State> {
  readonly message: string;
  readonly options: ReadonlyArray<CycleChoice<State>>;
  readonly visibleCount?: number;
  /** Keep the prompt open when Enter is pressed without changing any row. */
  readonly requireChange?: boolean;
  readonly unchangedMessage?: string;
}

export interface AwaitExternalOptions {
  readonly message: string;
  readonly waitingLabel: string;
  readonly url?: string;
  readonly openFailed?: boolean;
  /** Open the authorization URL again from the waiting screen. */
  readonly onOpen?: () => Promise<void>;
  readonly inputLabel: string;
  readonly placeholder?: string;
  readonly validate?: (value: string) => string | Error | undefined;
}

/** A navigable application menu. Selecting an item does not commit output. */
export interface MenuOptions<Value> extends SelectOptions<Value> {
  readonly header?: View;
  readonly footer?: View;
  /**
   * Value returned by Escape. Without it, Escape cancels the application.
   * `undefined` is a valid back value when it is part of `Value`; presence of
   * the property, rather than its value, determines whether a back target
   * exists.
   */
  readonly back?: Value;
}

export interface ScreenController<Value> {
  readonly submit: (value: Value, summary?: View) => void;
  readonly cancel: () => void;
}

/**
 * A custom interactive scene. The scene owns its local component state while
 * CliKit owns input streams, serialization, rendering and teardown.
 */
export interface Screen<Value> {
  readonly name: string;
  readonly render: (controller: ScreenController<Value>) => View;
}

export const Screen = {
  make: <Value>(
    name: string,
    render: (controller: ScreenController<Value>) => View,
  ): Screen<Value> => ({ name, render }),
};

export interface ProgressOptions {
  readonly label: string;
  readonly detail?: string;
}

export interface ProgressHandle {
  readonly update: (options: ProgressOptions) => Effect.Effect<void>;
  readonly succeed: (message?: string) => Effect.Effect<void>;
  readonly fail: (message?: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

/** A service-owned mutable view in the renderer's live region. */
export interface LiveViewHandle {
  readonly update: (view: View) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface LiveViewOptions {
  /** Place an application shell/header before completed prompt output. */
  readonly placement?: "beforeTranscript" | "afterTranscript";
  /** Commit the final view to the static transcript when it closes. */
  readonly persistOnClose?: boolean;
}

export type InteractionError = TerminalCancelled | NonInteractiveTerminal;

export interface CliKitOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** Override automatic TTY input detection. Primarily useful for tests. */
  readonly input?: boolean;
  readonly colors?: boolean;
  readonly unicode?: boolean;
  /** Capture console output while the interactive renderer owns the tty. */
  readonly captureConsole?: boolean;
}
