import * as Ssh from "@/Ssh";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fakeClient, ok } from "../FakeClient.ts";

describe("Ssh.Steps.exec", { tags: ["unit", "local"] }, () => {
  it.effect("skips the command when `creates` exists", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ok());
      const summary = yield* fake.run(() =>
        Ssh.Steps.exec({
          command: "make install",
          creates: "/usr/local/bin/app",
        }),
      );

      expect(summary.changed).toBe(0);
      expect(fake.issued.map((call) => call.command)).toEqual([
        "test -e '/usr/local/bin/app'",
      ]);
    }),
  );

  it.effect("matches `creates` globs", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ({ code: 2 }));
      yield* fake.run(
        () => Ssh.Steps.exec({ command: "unpack", creates: "/opt/app-*" }),
        "check",
      );

      expect(fake.issued[0]!.command).toBe(
        "ls -d -- /opt/app-* >/dev/null 2>&1",
      );
    }),
  );

  it.effect("reports no change when `changed` says so", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ok("already up to date"));
      const summary = yield* fake.run(() =>
        Ssh.Steps.exec({
          command: "app migrate",
          changed: (result) => !result.stdout.includes("already up to date"),
        }),
      );

      expect(summary.changed).toBe(0);
    }),
  );

  it.effect("fails on a non-zero exit", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ({ code: 2, stderr: "boom" }));
      const error = yield* Effect.flip(
        fake.run(() => Ssh.Steps.exec({ command: "false" })),
      );

      expect(error.message).toBe("exec[false]: command exited 2: boom");
    }),
  );
});
