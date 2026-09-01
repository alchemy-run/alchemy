/**
 * A headless {@link CliKit}: plain-text output on stderr, no rendering, no
 * input. For NON-INTERACTIVE CHILD PROCESSES (the Vite dev child, build
 * runners) whose output is piped and whose runtime may be plain `node` —
 * which cannot load the `.tsx` view components the full runtime dynamically
 * imports (`Unknown file extension ".tsx"`; node's type stripping covers
 * `.ts` only). This module is deliberately pure TypeScript with no view
 * imports, so it is loadable by any runtime.
 *
 * Prompts fail with {@link NonInteractiveTerminal} — a child that reaches
 * an interactive path is a bug to surface, not a hang to render.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { MessageOptions, View } from "../components/types.ts";
import { CliKit } from "./CliKit.ts";
import { NonInteractiveTerminal } from "./errors.ts";

const write = (line: string) =>
  Effect.sync(() => {
    process.stderr.write(`${line}\n`);
  });

const messageText = (message: string | MessageOptions): string =>
  typeof message === "string"
    ? message
    : ((message as { text?: string; title?: string }).text ??
      (message as { title?: string }).title ??
      JSON.stringify(message));

/**
 * Views are component trees meant for the sigil renderer; headless output
 * degrades them to a stable one-line description rather than pretending to
 * lay them out.
 */
const formatView = (view: View): string =>
  typeof view === "string"
    ? view
    : `[view ${String((view as { type?: unknown })?.type ?? "unknown")}]`;

const refuse = <A = never>(
  operation: string,
): Effect.Effect<A, NonInteractiveTerminal> =>
  Effect.fail(
    new NonInteractiveTerminal({
      operation,
      message: `${operation} is unavailable in a headless child process`,
    }),
  );

/** Provides the headless {@link CliKit}. */
export const headless = (): Layer.Layer<CliKit> =>
  Layer.succeed(
    CliKit,
    CliKit.of({
      terminal: {
        input: false,
        columns: 80,
        rows: 24,
        colors: false,
        unicode: false,
        alternateScreen: false,
      },
      nativeProgress: { set: () => Effect.void },
      output: {
        print: (view) => write(formatView(view)),
        format: (view) => formatView(view),
        render: (view) => Effect.succeed(formatView(view)),
        info: (message) => write(messageText(message)),
        success: (message) => write(messageText(message)),
        warning: (message) => write(messageText(message)),
        error: (message) => write(messageText(message)),
      },
      prompt: {
        text: () => refuse("prompt.text"),
        password: () => refuse("prompt.password"),
        confirm: () => refuse("prompt.confirm"),
        select: () => refuse("prompt.select"),
        multiSelect: () => refuse("prompt.multiSelect"),
        cycle: () => refuse("prompt.cycle"),
        awaitExternal: () => refuse("prompt.awaitExternal"),
        menu: () => refuse("prompt.menu"),
        custom: () => refuse("prompt.custom"),
      },
      wizard: () => refuse("wizard"),
      application: () => refuse("application"),
      live: {
        progress: () =>
          Effect.succeed({
            update: () => Effect.void,
            succeed: () => Effect.void,
            fail: () => Effect.void,
            close: Effect.void,
          }),
        open: (view) =>
          write(formatView(view)).pipe(Effect.as({ close: Effect.void })),
      },
      task: (_options, effect) => effect,
    }),
  );
