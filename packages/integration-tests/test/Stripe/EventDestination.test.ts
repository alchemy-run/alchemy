import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { withRequestOptions } from "@distilled.cloud/stripe";
import { GetCoreEventDestination } from "@distilled.cloud/stripe/stripe";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const atV2ApiVersion = withRequestOptions({ apiVersion: "2026-10-28.endive" });

const getDestination = (id: string) =>
  GetCoreEventDestination({ id, include: ["webhook_endpoint.url"] }).pipe(atV2ApiVersion);

const waitUntilGone = (id: string) =>
  getDestination(id).pipe(
    Effect.as("found" as const),
    Effect.catchTag("EventDestinationNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const meterErrors = "v1.billing.meter.error_report_triggered";
const meterNoMeter = "v1.billing.meter.no_meter_found";

test.provider(
  "create, update, disable, and delete a webhook event destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (props: Partial<Stripe.EventDestinationProps>) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.EventDestination("MeterEvents", {
              enabledEvents: [meterErrors],
              webhookEndpoint: { url: "https://example.com/alchemy/stripe-events" },
              ...props,
            });
          }),
        );

      const created = yield* deploy({ metadata: { team: "billing" } });
      yield* expectFound(Stripe.EventDestination.lookup({ id: created.id }), created, {
        ignore: ["signingSecret"],
      });

      expect(created.id).toMatch(/^ed_/);
      expect(created.type).toEqual("webhook_endpoint");
      expect(created.eventPayload).toEqual("thin");
      expect(created.eventsFrom).toEqual(["@self"]);
      expect(created.status).toEqual("enabled");
      expect(created.webhookUrl).toEqual("https://example.com/alchemy/stripe-events");
      expect(created.metadata).toEqual({ team: "billing" });
      expect(created.signingSecret).toBeDefined();
      expect(Redacted.value(created.signingSecret!)).toMatch(/^whsec_/);

      const fetched = yield* getDestination(created.id);
      expect(fetched.enabled_events).toEqual([meterErrors]);
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.stack]).toBeDefined();

      const updated = yield* deploy({
        description: "Meter errors and missing meters",
        enabledEvents: [meterErrors, meterNoMeter],
        webhookEndpoint: { url: "https://example.com/alchemy/stripe-events-v2" },
        metadata: { team: "platform" },
      });
      expect(updated.id).toEqual(created.id);
      expect(updated.description).toEqual("Meter errors and missing meters");
      expect(updated.enabledEvents).toEqual([meterErrors, meterNoMeter]);
      expect(updated.webhookUrl).toEqual("https://example.com/alchemy/stripe-events-v2");
      expect(updated.metadata).toEqual({ team: "platform" });
      expect(Redacted.value(updated.signingSecret!)).toEqual(
        Redacted.value(created.signingSecret!),
      );

      const refetched = yield* getDestination(created.id);
      expect(refetched.webhook_endpoint?.url).toEqual(
        "https://example.com/alchemy/stripe-events-v2",
      );
      expect(refetched.metadata?.team).toEqual("platform");

      const disabled = yield* deploy({
        description: "Meter errors and missing meters",
        enabledEvents: [meterErrors, meterNoMeter],
        webhookEndpoint: { url: "https://example.com/alchemy/stripe-events-v2" },
        metadata: { team: "platform" },
        disabled: true,
      });
      expect(disabled.status).toEqual("disabled");
      expect((yield* getDestination(created.id)).status).toEqual("disabled");

      const provider = yield* Provider.findProvider(Stripe.EventDestination);
      const listed = yield* provider.list();
      expect(listed.find((destination) => destination.id === created.id)).toBeDefined();

      yield* stack.destroy();

      expect(yield* waitUntilGone(created.id)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:eventdestination", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "replace an event destination when its payload style changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (eventPayload: Stripe.EventDestinationPayload) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.EventDestination("CustomerEvents", {
              eventPayload,
              enabledEvents: eventPayload === "thin" ? [meterErrors] : ["customer.created"],
              ...(eventPayload === "snapshot" ? { snapshotApiVersion: "2026-10-28.endive" } : {}),
              webhookEndpoint: { url: "https://example.com/alchemy/stripe-customers" },
            });
          }),
        );

      const thin = yield* deploy("thin");
      expect(thin.eventPayload).toEqual("thin");

      const snapshot = yield* deploy("snapshot");
      expect(snapshot.id).not.toEqual(thin.id);
      expect(snapshot.eventPayload).toEqual("snapshot");
      expect(snapshot.enabledEvents).toEqual(["customer.created"]);
      expect(yield* waitUntilGone(thin.id)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* waitUntilGone(snapshot.id)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:eventdestination", "live"],
    timeout: 120_000,
  },
);
