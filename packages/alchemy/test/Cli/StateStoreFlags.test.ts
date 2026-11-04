import { expect, it } from "@alchemy.run/test";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import { stateCommand } from "@/Cli/commands/state.ts";
import * as Contributions from "@/Contributions.ts";

const withFlags = (flags: Contributions.StateStoreFlags) =>
  Contributions.make({
    name: "fake",
    stateStores: {
      fake: {
        description: "Fake store",
        flags,
        load: Effect.die("not loaded"),
      },
    },
  });

it(
  "leaves out a store flag that clashes with alchemy state's own",
  () => {
    // `--profile` is `alchemy state`'s own flag and `--stack` a subcommand's;
    // either would otherwise fail building the whole command.
    expect(() =>
      stateCommand([
        withFlags({
          profile: Flag.String("profile"),
          stack: Flag.String("stack"),
          region: Flag.String("region"),
        }),
      ]),
    ).not.toThrow();
  },
  { tags: ["unit"] },
);
