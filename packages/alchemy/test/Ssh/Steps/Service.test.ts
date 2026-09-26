import * as Ssh from "@/Ssh";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fakeClient, ok } from "../FakeClient.ts";

const show = (props: Record<string, string>) =>
  ok(
    Object.entries({
      LoadState: "loaded",
      ActiveState: "active",
      UnitFileState: "enabled",
      NeedDaemonReload: "no",
      ...props,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );

describe("Ssh.Steps.service", { tags: ["unit", "local"] }, () => {
  it.effect("counts a static unit as enabled", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => show({ UnitFileState: "static" }));
      const summary = yield* fake.run(
        () =>
          Ssh.Steps.service({ name: "nginx", enabled: true, state: "started" }),
        "check",
      );

      expect(summary.pending).toEqual([]);
    }),
  );

  it.effect("leaves a static unit alone when asked to disable it", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => show({ UnitFileState: "static" }));
      const summary = yield* fake.run(() =>
        Ssh.Steps.service({ name: "nginx", enabled: false }),
      );

      expect(summary.changed).toBe(0);
    }),
  );

  it.effect("reloads systemd when a unit file changed on disk", () =>
    Effect.gen(function* () {
      let reloaded = false;
      const fake = fakeClient((command) => {
        if (command === "systemctl daemon-reload") reloaded = true;
        return command.startsWith("systemctl show")
          ? show({ NeedDaemonReload: reloaded ? "no" : "yes" })
          : ok();
      });
      const summary = yield* fake.run(() =>
        Ssh.Steps.service({ name: "nginx", daemonReload: true }),
      );

      expect(summary.changed).toBe(1);
      expect(reloaded).toBe(true);
    }),
  );

  it.effect("restarts on every apply", () =>
    Effect.gen(function* () {
      const fake = fakeClient((command) =>
        command.startsWith("systemctl show") ? show({}) : ok(),
      );
      const summary = yield* fake.run(() =>
        Ssh.Steps.service({ name: "nginx", state: "restarted" }),
      );

      expect(summary.changed).toBe(1);
      expect(fake.issued.map((call) => call.command)).toContain(
        "systemctl restart 'nginx'",
      );
    }),
  );
});
