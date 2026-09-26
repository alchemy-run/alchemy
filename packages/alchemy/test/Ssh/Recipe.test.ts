import * as Ssh from "@/Ssh";
import { assert, describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fakeClient, lost, ok } from "./FakeClient.ts";

/** A step over an in-memory flag: diverged until `apply` sets it. */
const flag = (
  name: string,
  options: {
    state?: { set: boolean };
    notify?: string[];
    sticks?: boolean;
    check?: Effect.Effect<void, Ssh.StepError, Ssh.Client>;
  } = {},
) => {
  const state = options.state ?? { set: false };
  const calls = { check: 0, apply: 0 };
  const step: Ssh.Step<boolean> = {
    kind: "flag",
    name,
    notify: options.notify,
    check: Effect.gen(function* () {
      calls.check++;
      if (options.check) yield* options.check;
      return state.set
        ? Ssh.converged(true)
        : Ssh.diverged({ set: false }, { set: true });
    }),
    apply: Effect.sync(() => {
      calls.apply++;
      if (options.sticks !== false) state.set = true;
      return Ssh.applied(true);
    }),
  };
  return { step, calls, state };
};

describe("Ssh.run", { tags: ["unit", "local"] }, () => {
  it.effect("a dry run reports what would change and applies nothing", () =>
    Effect.gen(function* () {
      const a = flag("a", { notify: ["restart"] });
      const b = flag("b", { state: { set: true } });
      const restarted: string[] = [];
      const fake = fakeClient(() => ok());
      const summary = yield* fake.run(
        () =>
          Effect.gen(function* () {
            yield* Ssh.execute(a.step);
            yield* Ssh.execute(b.step);
          }),
        "check",
        {
          restart: Effect.sync(() => restarted.push("restart")),
        },
      );

      expect(a.calls.apply).toBe(0);
      expect(restarted).toEqual([]);
      expect(summary.pending).toEqual(["flag[a]", "handler[restart]"]);
      expect(summary.steps[0]!.diff).toEqual({
        current: { set: false },
        desired: { set: true },
      });
    }),
  );

  it.effect("runs each notified handler once, in declaration order", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const fake = fakeClient(() => ok());
      const summary = yield* fake.run(
        () =>
          Effect.gen(function* () {
            yield* Ssh.execute(
              flag("a", { notify: ["reload", "restart"] }).step,
            );
            yield* Ssh.execute(flag("b", { notify: ["restart"] }).step);
          }),
        "apply",
        {
          restart: Effect.sync(() => order.push("restart")),
          reload: Effect.sync(() => order.push("reload")),
        },
      );

      expect(summary.changed).toBe(2);
      expect(summary.pending).toEqual([]);
      expect(order).toEqual(["restart", "reload"]);
    }),
  );

  it.effect("fails a step whose apply does not converge", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ok());
      const error = yield* Effect.flip(
        fake.run(() => Ssh.execute(flag("a", { sticks: false }).step)),
      );

      assert(error._tag === "Ssh.StepFailed");
      expect(error.message).toContain("flag[a] still diverges after apply");
    }),
  );

  it.live("retries a lost session during check, never during apply", () =>
    Effect.gen(function* () {
      let drops = 1;
      const retried = flag("check", {
        check: Effect.suspend(() =>
          drops-- > 0 ? Effect.fail(lost()) : Effect.void,
        ),
      });
      const fake = fakeClient(() => ok());
      yield* fake.run(() => Ssh.execute(retried.step));
      expect(retried.calls.check).toBe(3);

      const applyLost: Ssh.Step<void> = {
        kind: "flag",
        name: "apply",
        check: Effect.succeed(Ssh.diverged({}, { set: true })),
        apply: Effect.fail(lost()),
      };
      const error = yield* Effect.flip(fake.run(() => Ssh.execute(applyLost)));
      expect(error._tag).toBe("Ssh.ConnectionLost");
    }),
  );

  it.effect("redacts step names and diffs", () =>
    Effect.gen(function* () {
      const secret = "hunter2-sentinel";
      const fake = fakeClient(() => ok(), {
        redact: (value) => value.replaceAll(secret, "[REDACTED]"),
      });
      const leaky: Ssh.Step<void> = {
        kind: "exec",
        name: `curl -H 'token: ${secret}'`,
        check: Effect.succeed(Ssh.diverged({}, { token: secret })),
        apply: Effect.succeed(Ssh.applied(undefined)),
      };
      const summary = yield* fake.run(() => Ssh.execute(leaky), "check");

      expect(JSON.stringify(summary)).not.toContain(secret);
      expect(summary.pending).toEqual(["exec[curl -H 'token: [REDACTED]']"]);
    }),
  );

  it.effect("fails on a handler the recipe does not declare", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ok());
      const error = yield* Effect.flip(
        fake.run(() => Ssh.execute(flag("a", { notify: ["missing"] }).step)),
      );

      expect(error._tag).toBe("Ssh.HandlerUnknown");
    }),
  );

  it.effect("fails when the vars do not match the recipe's schema", () =>
    Effect.gen(function* () {
      const recipe = Ssh.make({
        main: import.meta.url,
        name: "typed",
        vars: Schema.Struct({ port: Schema.Number }),
        run: () => Effect.void,
      });
      const error = yield* Effect.flip(
        Ssh.run(recipe, {
          client: fakeClient(() => ok()).client,
          mode: "apply",
          vars: { port: "80" },
        }),
      );

      expect(error._tag).toBe("Ssh.VarsInvalid");
    }),
  );

  it.effect("probes facts once per run", () =>
    Effect.gen(function* () {
      const fake = fakeClient(() => ok(), { facts: { pkgManager: "dnf" } });
      const managers: Array<string | undefined> = [];
      yield* fake.run(() =>
        Effect.gen(function* () {
          managers.push((yield* Ssh.facts).pkgManager);
          managers.push((yield* Ssh.facts).pkgManager);
        }),
      );

      expect(managers).toEqual(["dnf", "dnf"]);
      expect(
        fake.issued.filter((call) =>
          call.command.startsWith(". /etc/os-release"),
        ),
      ).toHaveLength(1);
    }),
  );
});
