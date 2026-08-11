import * as Command from "effect/unstable/cli/Command";
import { describe, expect, test } from "alchemy-test";

import { _internal } from "@/Cli/main.ts";

describe("CLI command loading", () => {
  test("does not load command implementations for root help", async () => {
    const loaded: string[] = [];
    const result = await _internal.makeCli(["--help"], async (name) => {
      loaded.push(name);
      return Command.make(name, {});
    });

    expect(loaded).toEqual([]);
    expect(result.needsCommandServices).toBe(false);
  });

  test("loads only the selected command implementation", async () => {
    const loaded: string[] = [];
    const result = await _internal.makeCli(
      ["--log-level", "debug", "dev", "--help"],
      async (name) => {
        loaded.push(name);
        return Command.make(name, {});
      },
    );

    expect(loaded).toEqual(["dev"]);
    expect(result.needsCommandServices).toBe(false);
  });

  test("builds command services when a handler will run", async () => {
    const result = await _internal.makeCli(["deploy"], async (name) =>
      Command.make(name, {}),
    );

    expect(result.needsCommandServices).toBe(true);
  });

  test("does not mistake an unknown command's arguments for a command", () => {
    expect(_internal.selectedCommand(["unknown", "dev"])).toBeUndefined();
  });
});
