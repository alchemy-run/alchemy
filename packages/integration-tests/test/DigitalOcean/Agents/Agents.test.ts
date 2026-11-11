import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getHarnessConfig, harnessGetTrigger } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:agents", "live"];

const manifest = (adapter: string) => ({
  apiVersion: "agents.digitalocean.com/v1alpha1",
  kind: "Agent",
  spec: { runtime: { adapter } },
});

const resources = (adapter: string, cron: string) =>
  Effect.gen(function* () {
    const env = yield* DigitalOcean.Agents.EnvironmentConfig("Env", {
      manifest: manifest(adapter),
    });
    const trigger = yield* DigitalOcean.Agents.Trigger("Nightly", {
      cron: { expression: cron, timeZone: "UTC" },
      prompt: "Say hello.",
      session: manifest(adapter),
      enabled: false,
    });
    return { configId: env.configId, triggerId: trigger.triggerId };
  });

test.provider(
  "environment config and cron trigger: create, replace the config, update the trigger, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(resources("opencode", "0 3 * * *"));
      const config = yield* getHarnessConfig({ config_id: created.configId });
      expect(config.config.manifest).toMatchObject({ spec: { runtime: { adapter: "opencode" } } });
      const trigger = yield* harnessGetTrigger({ trigger_id: created.triggerId });
      expect(trigger.trigger.cron?.cron_expr).toEqual("0 3 * * *");
      expect(trigger.trigger.status).toEqual("paused");

      // A config is immutable: a new manifest replaces it. The trigger updates in place.
      const updated = yield* stack.deploy(resources("claude-code", "0 4 * * *"));
      expect(updated.configId).not.toEqual(created.configId);
      expect(updated.triggerId).toEqual(created.triggerId);
      expect(yield* isGone(getHarnessConfig({ config_id: created.configId }))).toBe(true);
      const after = yield* harnessGetTrigger({ trigger_id: created.triggerId });
      expect(after.trigger.cron?.cron_expr).toEqual("0 4 * * *");

      const plan = yield* stack.plan(resources("claude-code", "0 4 * * *"));
      expect(Object.values(plan.resources).filter((node) => node.action !== "noop")).toEqual([]);

      yield* stack.destroy();
      expect(yield* isGone(getHarnessConfig({ config_id: updated.configId }))).toBe(true);
      expect(yield* isGone(harnessGetTrigger({ trigger_id: created.triggerId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);
