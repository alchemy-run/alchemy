import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import { CliKit } from "./CliKit/CliKit.ts";
import { LoggingCli } from "./LoggingCli.ts";
import { plainCliFormatter } from "./PlainCliFormatter.ts";

/** Select the interactive or append-only root renderer. */
export const selectCliServices = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cli = yield* CliKit;
      if (!cli.terminal.input) {
        return Layer.mergeAll(
          LoggingCli,
          CliOutput.layer(plainCliFormatter({ columns: cli.terminal.columns })),
        );
      }

      return yield* Effect.promise(async () => {
        const { sigilCli } = await import("./components/view/SigilCli.tsx");
        const { brandedCliFormatter } =
          await import("./components/view/Help.tsx");
        return Layer.mergeAll(
          sigilCli(),
          CliOutput.layer(brandedCliFormatter(cli)),
        );
      });
    }),
  );
