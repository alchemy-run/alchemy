import * as Ssh from "@/Ssh";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fakeClient } from "../FakeClient.ts";

const markers = { begin: "# BEGIN", end: "# END" };

describe("Ssh.Steps.managedBlock", { tags: ["unit", "local"] }, () => {
  it("replaces an existing block where it is", () => {
    expect(
      Ssh.Steps.rebuild("a\n# BEGIN\nold\n# END\nb\n", "new", markers),
    ).toBe("a\n# BEGIN\nnew\n# END\nb\n");
  });

  it("appends a new block and is stable on a second run", () => {
    const once = Ssh.Steps.rebuild("a\n", "block\n", markers);
    expect(once).toBe("a\n# BEGIN\nblock\n# END\n");
    expect(Ssh.Steps.rebuild(once!, "block\n", markers)).toBe(once);
  });

  it("refuses a file with one marker and not the other", () => {
    expect(
      Ssh.Steps.rebuild("a\n# BEGIN\nrest of the file\n", "x", markers),
    ).toBeUndefined();
  });

  it.effect("fails on a missing file unless create is set", () =>
    Effect.gen(function* () {
      const missing = () => ({ code: 66 });
      const step = { path: "/etc/app.conf", block: "x", commentPrefix: "#" };

      const error = yield* Effect.flip(
        fakeClient(missing).run(() => Ssh.Steps.managedBlock(step), "check"),
      );
      expect(error.message).toContain("/etc/app.conf does not exist");

      const summary = yield* fakeClient(missing).run(
        () => Ssh.Steps.managedBlock({ ...step, create: true }),
        "check",
      );
      expect(summary.pending).toEqual(["managedBlock[/etc/app.conf#alchemy]"]);
    }),
  );
});
