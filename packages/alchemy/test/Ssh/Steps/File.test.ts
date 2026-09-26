import * as Ssh from "@/Ssh";
import { writeScript } from "@/Ssh/Steps/internal.ts";
import { sha256 } from "@/Util/sha256.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fakeClient, ok } from "../FakeClient.ts";

describe("Ssh.Steps.file", { tags: ["unit", "local"] }, () => {
  it.effect("converges when content and mode match", () =>
    Effect.gen(function* () {
      const checksum = yield* sha256("hello\n");
      const fake = fakeClient(() =>
        ok(`regular file|644 root root\n${checksum}\n`),
      );
      const summary = yield* fake.run(
        () =>
          Ssh.Steps.file({
            path: "/etc/motd",
            content: "hello\n",
            mode: "0644",
          }),
        "check",
      );

      expect(summary.pending).toEqual([]);
    }),
  );

  it.effect("reports only what differs", () =>
    Effect.gen(function* () {
      const checksum = yield* sha256("hello\n");
      const fake = fakeClient(() =>
        ok(`regular file|600 root root\n${checksum}\n`),
      );
      const summary = yield* fake.run(
        () =>
          Ssh.Steps.file({
            path: "/etc/motd",
            content: "hello\n",
            mode: 0o644,
          }),
        "check",
      );

      expect(summary.steps[0]!.diff).toEqual({
        current: { mode: "600" },
        desired: { mode: "644" },
      });
    }),
  );

  it.effect("fails rather than converge on a file it cannot read", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ({
        code: 1,
        stderr: "stat: cannot statx '/root/secret': Permission denied",
      }));
      const error = yield* Effect.flip(
        fake.run(
          () => Ssh.Steps.file({ path: "/root/secret", state: "absent" }),
          "check",
        ),
      );

      expect(error._tag).toBe("Ssh.StepFailed");
      expect(error.message).toContain("Permission denied");
    }),
  );

  it("keeps the existing mode and owner on an atomic replace", () => {
    const script = writeScript("/etc/app.conf", { atomic: true });

    expect(script).toContain(`chmod --reference='/etc/app.conf' "$t"`);
    expect(script).toContain(`chown --reference='/etc/app.conf' "$t"`);
    expect(script.indexOf("--reference")).toBeLessThan(script.indexOf("mv -f"));
  });
});
