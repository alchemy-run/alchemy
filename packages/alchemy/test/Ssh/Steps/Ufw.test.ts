import * as Ssh from "@/Ssh";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fakeClient, ok } from "../FakeClient.ts";

const rules = ["limit ssh", "allow from 10.0.0.0/8 to any port 5432 proto tcp"];

describe("Ssh.Steps.ufw", { tags: ["unit", "local"] }, () => {
  it("parses defaults, enablement and which rules are missing", () => {
    expect(
      Ssh.Steps.parseUfwStatus(
        [
          'incoming="DROP"',
          'outgoing="ACCEPT"',
          "enabled=no",
          "rule0=present",
          "rule1=missing",
        ].join("\n"),
        rules,
      ),
    ).toEqual({
      enabled: false,
      incoming: "deny",
      outgoing: "allow",
      missing: [rules[1]],
    });
  });

  it("checks each rule with ufw's own dry run", () => {
    expect(Ssh.Steps.ufwStatusScript(rules)).toContain(
      "ufw --dry-run 'allow' 'from' '10.0.0.0/8' 'to' 'any' 'port' '5432' 'proto' 'tcp'",
    );
  });

  it.effect("adds only the missing rules, then enables", () =>
    Effect.gen(function* () {
      let enabled = false;
      const fake = fakeClient((command) => {
        if (command.includes("--dry-run")) {
          return ok(
            [
              'incoming="DROP"',
              'outgoing="ACCEPT"',
              `enabled=${enabled ? "yes" : "no"}`,
              "rule0=present",
              `rule1=${enabled ? "present" : "missing"}`,
            ].join("\n"),
          );
        }
        if (command === "ufw --force enable") enabled = true;
        return ok();
      });
      yield* fake.run(() =>
        Ssh.Steps.ufw({ defaults: { incoming: "deny" }, rules }),
      );

      expect(
        fake.issued
          .map((call) => call.command)
          .filter((command) => !command.includes("--dry-run")),
      ).toEqual([
        "ufw 'allow' 'from' '10.0.0.0/8' 'to' 'any' 'port' '5432' 'proto' 'tcp'",
        "ufw --force enable",
      ]);
    }),
  );

  it.effect("reports a host without ufw as diverged", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ok("MISSING\n"));
      const summary = yield* fake.run(() => Ssh.Steps.ufw({ rules }), "check");

      expect(summary.steps[0]!.diff?.current).toEqual({ installed: false });
    }),
  );
});
