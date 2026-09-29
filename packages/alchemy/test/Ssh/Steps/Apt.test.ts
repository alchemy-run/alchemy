import * as Ssh from "@/Ssh";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fakeClient, ok } from "../FakeClient.ts";

describe("Ssh.Steps.apt", { tags: ["unit", "local"] }, () => {
  it("counts a held package as installed", () => {
    expect(
      Ssh.Steps.parseDpkgQuery(
        [
          "nginx\thold ok installed\t1.24.0-2ubuntu7",
          "curl\tinstall ok installed\t8.5.0-2ubuntu10",
          "vim\tdeinstall ok config-files\t2:9.1.0016-1ubuntu7",
        ].join("\n"),
      ),
    ).toEqual({ nginx: "1.24.0-2ubuntu7", curl: "8.5.0-2ubuntu10" });
  });

  it("splits a version and architecture off a package spec", () => {
    expect(Ssh.Steps.parseAptSpec("nginx=1.24.0-2ubuntu7")).toEqual({
      name: "nginx",
      version: "1.24.0-2ubuntu7",
    });
    expect(Ssh.Steps.parseAptSpec("libc6:arm64")).toEqual({
      name: "libc6",
      version: undefined,
    });
  });

  it("parses installed and candidate versions from apt-cache policy", () => {
    expect(
      Ssh.Steps.parseAptCachePolicy(
        "nginx:\n  Installed: 1.24.0-2ubuntu7\n  Candidate: 1.24.0-2ubuntu7.1\n  Version table:\n",
      ),
    ).toEqual({
      nginx: { installed: "1.24.0-2ubuntu7", candidate: "1.24.0-2ubuntu7.1" },
    });
  });

  it.effect("diverges when a pinned version is not the installed one", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() =>
        ok("nginx\tinstall ok installed\t1.24.0-2ubuntu7\n"),
      );
      const summary = yield* fake.run(
        () => Ssh.Steps.apt({ packages: ["nginx=1.26.0-1"] }),
        "check",
      );

      expect(summary.steps[0]!.diff).toEqual({
        current: { installed: { nginx: "1.24.0-2ubuntu7" } },
        desired: { installed: ["nginx=1.26.0-1"] },
      });
    }),
  );
});
