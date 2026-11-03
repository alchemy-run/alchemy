import * as CliOutput from "effect/cli/CliOutput";
import type * as Prompt from "effect/cli/Prompt";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Interaction from "../Interaction.ts";
import type { Cli } from "../Report.ts";
import { suppressInterruptMessages } from "./commands/errors.ts";
import { currentConsoleSettings } from "./GlobalLog.ts";
import { LoggingCli } from "./LoggingCli.ts";
import { plainCliFormatter } from "./PlainCliFormatter.ts";

type SelectedCli = Layer.Layer<Cli, never, Interaction.Interaction | Prompt.Environment>;

/** Whether the console is JSON: the parsed `--log-format`, else `ALCHEMY_LOG_FORMAT`. */
export const jsonConsole = Effect.map(
  currentConsoleSettings,
  (settings) => settings.format === "json",
);

/**
 * A bad command line is an error: its usage text and errors print on
 * stderr, so stdout carries only what a command outputs (under
 * `--log-format json`, log records only). Requested help and the version
 * still print on stdout.
 */
const presenter: CliOutput.Presenter = {
  present: (event) =>
    event._tag === "Version" || (event._tag === "Help" && event.reason === "Requested")
      ? CliOutput.defaultPresenter.present(event)
      : Effect.gen(function* () {
          const formatter = yield* CliOutput.Formatter;
          yield* Console.error(formatter.formatHelpDoc(event.helpDoc));
          if (event._tag === "InvalidInvocation") {
            yield* Console.error(formatter.formatErrors(event.errors));
          }
        }),
};

/** The interactive or append-only CLI over the provided Interaction. */
const cliServices = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cli = yield* Interaction.Interaction;
      if (!cli.terminal.input) {
        const plain: SelectedCli = Layer.mergeAll(
          LoggingCli,
          CliOutput.layer(plainCliFormatter({ columns: cli.terminal.columns })),
          CliOutput.layerPresenter(presenter),
        );
        return plain;
      }

      return yield* Effect.promise<SelectedCli>(async () => {
        const { sigilCli } = await import("./components/view/SigilCli.tsx");
        const { brandedCliFormatter } = await import("./components/view/Help.tsx");
        return Layer.mergeAll(
          sigilCli(),
          CliOutput.layer(brandedCliFormatter(cli)),
          CliOutput.layerPresenter(presenter),
        );
      });
    }),
  );

/**
 * The CLI's renderer and its Interaction:
 *
 * - `--log-format json`: messages become log records on stdout, views print
 *   nothing, no prompts, and no shutdown or exit lines after the command;
 * - an interactive terminal: the Sigil UI;
 * - otherwise: plain log lines.
 */
export const selectRenderer = () =>
  Layer.unwrap(
    Effect.map(jsonConsole, (json) =>
      json
        ? Layer.provideMerge(cliServices(), Interaction.layerNonInteractive({ json: true })).pipe(
            Layer.merge(Layer.effectDiscard(suppressInterruptMessages)),
          )
        : Layer.provideMerge(cliServices(), Interaction.layer()),
    ),
  );
