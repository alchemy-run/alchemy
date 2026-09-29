import * as Ssh from "@/Ssh";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fakeClient, inOrder, ok } from "../FakeClient.ts";

describe("Ssh.Steps.dnf", { tags: ["unit", "local"] }, () => {
  it("parses installed versions from rpm -q", () => {
    expect(
      Ssh.Steps.parseRpmQuery(
        "nginx\t1.26.3-1.fc42\npackage vim is not installed\n",
      ),
    ).toEqual({ nginx: "1.26.3-1.fc42" });
  });

  it("parses package names from dnf check-update", () => {
    expect(
      Ssh.Steps.parseCheckUpdate(
        "\nnginx.x86_64    2:1.28.0-1.fc42    updates\n",
      ),
    ).toEqual(["nginx"]);
  });

  it.effect("diverges on latest when check-update exits 100", () =>
    Effect.gen(function* () {
      const fake = fakeClient(
        inOrder([
          ok("nginx\t1.26.3-1.fc42\n"),
          { code: 100, stdout: "nginx.x86_64  2:1.28.0-1.fc42  updates\n" },
        ]),
      );
      const summary = yield* fake.run(
        () => Ssh.Steps.dnf({ packages: "nginx", state: "latest" }),
        "check",
      );

      expect(summary.pending).toEqual(["dnf[nginx]"]);
      expect(summary.steps[0]!.diff?.current).toEqual({ outdated: ["nginx"] });
    }),
  );
});
