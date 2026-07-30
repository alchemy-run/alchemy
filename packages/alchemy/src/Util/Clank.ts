import {
  Prompt as ClackPrompt,
  settings as clackSettings,
  wrapTextWithPrefix,
} from "@clack/core";
import * as p from "@clack/prompts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";
import { styleText } from "node:util";

export class PromptCancelled extends Data.TaggedError("PromptCancelled") {}
export const retryIfCancelled = Effect.retry({
  while: (e: unknown) => e instanceof PromptCancelled,
});

/**
 * Wraps a clack prompt (which returns a `Promise<T | symbol>` where the
 * symbol indicates user cancellation) in an Effect.
 *
 * Returns `undefined` if the user cancels (Ctrl+C / Escape).
 *
 * Uses `Effect.callback` so fiber interruption propagates to the clack
 * prompt through its abort signal, releasing stdin and restoring the cursor.
 */
export const prompt = <T>(
  fn: (signal: AbortSignal) => Promise<T | symbol>,
): Effect.Effect<T, PromptCancelled> =>
  Effect.callback<T, PromptCancelled>((resume, signal) => {
    let settled = false;
    fn(signal).then(
      (result) => {
        if (settled || signal.aborted) return;
        settled = true;
        if (p.isCancel(result)) {
          resume(Effect.fail(new PromptCancelled()));
        } else {
          resume(Effect.succeed(result as T));
        }
      },
      (err) => {
        if (settled || signal.aborted) return;
        settled = true;
        resume(Effect.die(err));
      },
    );
  });

export const success = (str: string) => Effect.sync(() => p.log.success(str));
export const warn = (str: string) => Effect.sync(() => p.log.warn(str));
export const error = (str: string) => Effect.sync(() => p.log.error(str));
export const info = (str: string) => Effect.sync(() => p.log.info(str));
type TextOptions = Omit<p.TextOptions, "validate"> & {
  validate?: (value: string) => string | Error | undefined;
};

type PasswordOptions = Omit<p.PasswordOptions, "validate"> & {
  validate?: (value: string) => string | Error | undefined;
};

export const text = (opts: TextOptions) => {
  const validate = opts.validate;
  return prompt<string>((signal) =>
    p.text({
      ...opts,
      signal,
      validate:
        validate === undefined ? undefined : (value) => validate(value ?? ""),
    }),
  );
};
export const password = (opts: PasswordOptions) => {
  const validate = opts.validate;
  return prompt<string>((signal) =>
    p.password({
      ...opts,
      signal,
      validate:
        validate === undefined ? undefined : (value) => validate(value ?? ""),
    }),
  );
};
export const select = <Value>(opts: p.SelectOptions<Value>) =>
  prompt((signal) => p.select<Value>({ ...opts, signal }));
export const confirm = (opts: p.ConfirmOptions) =>
  prompt((signal) => p.confirm({ ...opts, signal }));
export const multiselect = <Value>(opts: p.MultiSelectOptions<Value>) =>
  prompt((signal) => p.multiselect<Value>({ ...opts, signal }));

export interface CycleSelectState<Value> {
  value: Value;
  /** Pre-styled glyph rendered before the label. */
  icon: string;
  /** Pre-styled action word rendered after the label. */
  annotation?: string;
}

export interface CycleSelectOption<Value> {
  label: string;
  /** Rendered dimmed in parentheses after the label. */
  hint?: string;
  /**
   * The states Space cycles through. `states[0]` is the neutral
   * "no change" state every row starts in.
   */
  states: ReadonlyArray<CycleSelectState<Value>>;
}

/**
 * A select where every row is a multi-state toggle: ↑/↓ move between rows,
 * Space (or ←/→) cycles the focused row through its states, Enter submits.
 * Resolves with the selected state's value for each row, in row order.
 */
class CyclePrompt<Value> extends ClackPrompt<Value[]> {
  cursor = 0;
  readonly indices: number[];
  readonly options: ReadonlyArray<CycleSelectOption<Value>>;

  constructor(opts: {
    options: ReadonlyArray<CycleSelectOption<Value>>;
    render: (this: CyclePrompt<Value>) => string;
    signal?: AbortSignal;
  }) {
    super(opts as ConstructorParameters<typeof ClackPrompt<Value[]>>[0], false);
    this.options = opts.options;
    this.indices = opts.options.map(() => 0);
    this.value = this.currentValues();
    this.on("cursor", (direction) => {
      const rows = this.options.length;
      switch (direction) {
        case "up":
          this.cursor = (this.cursor + rows - 1) % rows;
          break;
        case "down":
          this.cursor = (this.cursor + 1) % rows;
          break;
        case "left":
          this.cycle(-1);
          break;
        case "right":
        case "space":
          this.cycle(1);
          break;
      }
    });
  }

  private cycle(delta: number) {
    const states = this.options[this.cursor]!.states;
    this.indices[this.cursor] =
      (this.indices[this.cursor]! + delta + states.length) % states.length;
    this.value = this.currentValues();
  }

  private currentValues(): Value[] {
    return this.options.map(
      (option, i) => option.states[this.indices[i]!]!.value,
    );
  }
}

const renderCyclePrompt = <Value>(
  self: CyclePrompt<Value>,
  message: string,
): string => {
  const withGuide = clackSettings.withGuide;
  const titleBody = wrapTextWithPrefix(
    process.stdout,
    message,
    withGuide ? `${p.symbolBar(self.state)}  ` : "",
    `${p.symbol(self.state)}  `,
  );
  const title = `${withGuide ? `${styleText("gray", p.S_BAR)}\n` : ""}${titleBody}\n`;

  // Rows whose state was cycled away from the neutral default.
  const changes = self.options.flatMap((option, i) => {
    const state = option.states[self.indices[i]!]!;
    return self.indices[i] === 0
      ? []
      : [`${state.annotation ?? state.icon} ${option.label}`];
  });

  switch (self.state) {
    case "submit": {
      const summary =
        changes.join(styleText("dim", ", ")) || styleText("dim", "no changes");
      return `${title}${withGuide ? `${styleText("gray", p.S_BAR)}  ` : ""}${summary}`;
    }
    case "cancel": {
      const summary = changes
        .map((change) => styleText(["strikethrough", "dim"], change))
        .join(styleText("dim", ", "));
      return `${title}${withGuide ? `${styleText("gray", p.S_BAR)}  ` : ""}${summary}${withGuide ? `\n${styleText("gray", p.S_BAR)}` : ""}`;
    }
    default: {
      const prefix = withGuide ? `${styleText("cyan", p.S_BAR)}  ` : "";
      const rows = self.options.map((option, i) => {
        const state = option.states[self.indices[i]!]!;
        const active = i === self.cursor;
        const parts = [
          state.icon,
          active ? option.label : styleText("dim", option.label),
        ];
        if (state.annotation !== undefined) parts.push(state.annotation);
        if (option.hint !== undefined) {
          parts.push(styleText("dim", `(${option.hint})`));
        }
        return `${prefix}${parts.join(" ")}`;
      });
      const footer = p
        .formatInstructionFooter(
          [
            `${styleText("dim", "↑/↓")} to navigate`,
            `${styleText("dim", "Space:")} change action`,
            `${styleText("dim", "Enter:")} confirm`,
          ],
          withGuide,
        )
        .join("\n");
      return `${title}${rows.join("\n")}\n${footer}\n`;
    }
  }
};

export const cycleSelect = <Value>(opts: {
  message: string;
  options: ReadonlyArray<CycleSelectOption<Value>>;
}) =>
  prompt<Value[]>(
    (signal) =>
      new CyclePrompt<Value>({
        options: opts.options,
        signal,
        render() {
          return renderCyclePrompt(this, opts.message);
        },
      }).prompt() as Promise<Value[] | symbol>,
  );

/**
 * Open a URL in the user's default browser.
 *
 * On Windows, uses rundll32's FileProtocolHandler — a built-in shim that
 * opens URLs in the default browser. It accepts the URL as a direct
 * argument (no shell, no quoting of `&`). cmd.exe `start` would treat
 * `&` in OAuth URLs as a command separator, and `explorer.exe` treats
 * its arg as a path.
 */
export const openUrl = (url: string) =>
  Effect.gen(function* () {
    const [cmd, args] =
      process.platform === "win32"
        ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    const handle = yield* ChildProcess.make(cmd, [...args], { shell: false });
    yield* handle.exitCode;
  }).pipe(Effect.scoped);
