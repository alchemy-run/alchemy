import { commandParts } from "@alchemy.run/rivet/AgentOs";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

describe("Rivet.AgentOs commandParts", { tags: ["provider:rivet", "unit", "local"] }, () => {
  it.effect("runs a shell line through sh -c", () =>
    Effect.sync(() => {
      expect(commandParts("uname -a")).toEqual({
        command: "sh",
        args: ["-c", "uname -a"],
      });
    }),
  );

  it.effect("passes an argument vector as command + args", () =>
    Effect.sync(() => {
      expect(commandParts(["node", "--version"])).toEqual({
        command: "node",
        args: ["--version"],
      });
    }),
  );

  it.effect("keeps a single-element vector as the command alone", () =>
    Effect.sync(() => {
      expect(commandParts(["uname"])).toEqual({
        command: "uname",
        args: [],
      });
    }),
  );
});
