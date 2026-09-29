import * as Ssh from "@/Ssh";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fakeClient, ok } from "../FakeClient.ts";

describe("Ssh.Steps.package", { tags: ["unit", "local"] }, () => {
  it.effect("picks the host's package manager", () =>
    Effect.gen(function* () {
      for (const [pkgManager, kind] of [
        ["apt", "apt"],
        ["dnf", "dnf"],
      ] as const) {
        const fake = fakeClient(() => ok(), { facts: { pkgManager } });
        const summary = yield* fake.run(
          () => Ssh.Steps.package({ packages: "git" }),
          "check",
        );
        expect(summary.pending).toEqual([`${kind}[git]`]);
      }
    }),
  );

  it.effect("fails on a host with neither apt nor dnf", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ok(), {
        facts: { distroId: "alpine", pkgManager: undefined },
      });
      const error = yield* Effect.flip(
        fake.run(() => Ssh.Steps.package({ packages: "git" }), "check"),
      );

      expect(error.message).toContain(
        "no supported package manager (apt or dnf) on alpine",
      );
    }),
  );
});
