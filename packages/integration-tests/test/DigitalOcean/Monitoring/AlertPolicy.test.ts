import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getMonitoringAlertPolicy } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { accountEmail, isGone, logLevel, testName } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:monitoring", "live"];
const LIVE_TIMEOUT = 120_000;

test.provider(
  "alert policy lifecycle: watch a tag, change the threshold and window in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const tag = testName(stack.stage, "alert-web");
      const email = yield* accountEmail;

      const declare = (value: number, window: "5m" | "10m") =>
        Effect.gen(function* () {
          const web = yield* DigitalOcean.Tag("Web", { name: tag });
          return yield* DigitalOcean.Monitoring.AlertPolicy("Cpu", {
            type: "v1/insights/droplet/cpu",
            description: "CPU is high",
            compare: "GreaterThan",
            value,
            window,
            tags: [web.name],
            email: [email],
          });
        });

      const created = yield* stack.deploy(declare(80, "5m"));
      expect(created).toMatchObject({ type: "v1/insights/droplet/cpu", enabled: true });

      const updated = yield* stack.deploy(declare(90, "10m"));
      expect(updated.alertPolicyId).toEqual(created.alertPolicyId);
      const remote = yield* getMonitoringAlertPolicy({ alert_uuid: created.alertPolicyId });
      expect(remote.policy).toMatchObject({ value: 90, window: "10m", tags: [tag] });

      yield* stack.destroy();

      expect(yield* isGone(getMonitoringAlertPolicy({ alert_uuid: created.alertPolicyId }))).toBe(
        true,
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
