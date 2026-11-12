import { commandParts } from "@alchemy.run/rivet/AgentOs";
import { describe, expect, it } from "@alchemy.run/test";

describe("Rivet.AgentOs commandParts", () => {
  it("runs a shell line through sh -c", () => {
    expect(commandParts("uname -a")).toEqual({
      command: "sh",
      args: ["-c", "uname -a"],
    });
  });

  it("passes an argument vector as command + args", () => {
    expect(commandParts(["node", "--version"])).toEqual({
      command: "node",
      args: ["--version"],
    });
  });

  it("keeps a single-element vector as the command alone", () => {
    expect(commandParts(["uname"])).toEqual({
      command: "uname",
      args: [],
    });
  });
});
