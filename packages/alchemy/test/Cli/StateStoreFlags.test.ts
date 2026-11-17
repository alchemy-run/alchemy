import { describe, expect, it } from "@alchemy.run/test";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import { stateCommand, storeOptionFlags } from "@/Cli/commands/state.ts";
import type * as Contributions from "@/Contributions.ts";

const provider = (
  name: string,
  stores: Readonly<Record<string, Contributions.StateStoreFlags>>,
): Contributions.Contributions => ({
  name,
  stateStores: Object.fromEntries(
    Object.entries(stores).map(([backend, flags]) => [
      backend,
      { description: `${backend} store`, flags, load: Effect.die("not loaded") },
    ]),
  ),
});

describe("state store flags", { tags: ["unit"] }, () => {
  it("keeps a store's own flags", () => {
    const flags = storeOptionFlags([provider("fake", { fake: { region: Flag.String("region") } })]);
    expect(Object.keys(flags.flags)).toEqual(["region"]);
  });

  it("leaves out a flag that clashes with alchemy state's own", () => {
    // `--profile` is `alchemy state`'s own, `--stack` a subcommand's and
    // `--yes` `unsafe nuke`'s; any would fail building the whole command.
    const contributions = [
      provider("fake", {
        fake: {
          profile: Flag.String("profile"),
          stack: Flag.String("stack"),
          yes: Flag.String("yes"),
          region: Flag.String("region"),
        },
      }),
    ];
    expect(Object.keys(storeOptionFlags(contributions).flags)).toEqual(["region"]);
    expect(() => stateCommand(contributions)).not.toThrow();
  });

  it("leaves out a flag with an alias", () => {
    const flags = storeOptionFlags([
      provider("fake", { fake: { region: Flag.String("region").pipe(Flag.withAlias("c")) } }),
    ]);
    expect(Object.keys(flags.flags)).toEqual([]);
  });

  it("shares a flag stores take for the same option", () => {
    const flags = storeOptionFlags([
      provider("one", { one: { name: Flag.String("name") } }),
      provider("two", { two: { name: Flag.String("name") } }),
    ]);
    expect(Object.keys(flags.flags)).toEqual(["name"]);
  });

  it("leaves out a flag another store uses for a different option", () => {
    const flags = storeOptionFlags([
      provider("one", { one: { name: Flag.String("name") } }),
      provider("two", { two: { workerName: Flag.String("name"), url: Flag.String("url") } }),
    ]);
    expect(Object.keys(flags.flags)).toEqual(["name", "url"]);
  });

  it("leaves out a flag with a default, which would always be set", () => {
    const flags = storeOptionFlags([
      provider("fake", { fake: { region: Flag.String("region").pipe(Flag.withDefault("eu")) } }),
    ]);
    expect(Object.keys(flags.flags)).toEqual([]);
  });

  it("leaves out a shared flag another store parses differently", () => {
    const flags = storeOptionFlags([
      provider("one", { one: { port: Flag.String("port") } }),
      provider("two", { two: { port: Flag.Int("port") } }),
    ]);
    expect(Object.keys(flags.flags)).toEqual(["port"]);
    // So `--backend two --port` is refused rather than handed one's string.
    expect(flags.ignored).toEqual({ two: ["port"] });
  });

  it("leaves out a different flag for an option another store already sets", () => {
    const flags = storeOptionFlags([
      provider("one", { one: { name: Flag.String("name") } }),
      provider("two", { two: { name: Flag.String("store-name") } }),
    ]);
    expect(Object.keys(flags.flags)).toEqual(["name"]);
  });
});
