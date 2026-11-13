import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getUptimeAlert } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { accountEmail, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:monitoring", "live"];
const LIVE_TIMEOUT = 120_000;

// The uptime API answers a missing id with 403, typed as UptimeCheckNotFound.
const isAlertGone = (checkId: string, alertId: string) =>
  getUptimeAlert({ check_id: checkId, alert_id: alertId }).pipe(
    Effect.as(false),
    Effect.catchTag(["NotFound", "UptimeCheckNotFound"], () => Effect.succeed(true)),
  );

test.provider(
  "uptime alert lifecycle: create, change type, threshold and period in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const email = yield* accountEmail;
      const declare = (alert: {
        type: "down" | "latency";
        threshold?: number;
        period: "2m" | "5m";
      }) =>
        Effect.gen(function* () {
          const check = yield* DigitalOcean.Monitoring.UptimeCheck("Site", {
            type: "https",
            target: "https://example.com",
          });
          const created = yield* DigitalOcean.Monitoring.UptimeAlert("Down", {
            checkId: check.checkId,
            ...alert,
            notifications: { email: [email] },
          });
          return { check, alert: created };
        });

      const created = yield* stack.deploy(declare({ type: "down", period: "2m" }));
      expect(created.alert).toMatchObject({ type: "down", checkId: created.check.checkId });

      const updated = yield* stack.deploy(
        declare({ type: "latency", threshold: 500, period: "5m" }),
      );
      expect(updated.alert.alertId).toEqual(created.alert.alertId);
      const remote = yield* getUptimeAlert({
        check_id: created.check.checkId,
        alert_id: created.alert.alertId,
      });
      expect(remote.alert).toMatchObject({ type: "latency", threshold: 500, period: "5m" });

      yield* stack.destroy();

      expect(yield* isAlertGone(created.check.checkId, created.alert.alertId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
