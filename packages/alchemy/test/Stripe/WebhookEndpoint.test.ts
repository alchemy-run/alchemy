import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetWebhookEndpointsWebhookEndpoint } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Deterministic, non-routable base URL. Stripe only validates the URL's
 * shape when registering an endpoint — it never probes it — so a stable
 * example.com host keeps every run reproducible.
 */
const BASE_URL = "https://alchemy-stripe-tests.example.com";

const fetchEndpoint = (webhookEndpointId: string) =>
  GetWebhookEndpointsWebhookEndpoint({ webhook_endpoint: webhookEndpointId });

const expectGone = (webhookEndpointId: string) =>
  Effect.gen(function* () {
    const result = yield* fetchEndpoint(webhookEndpointId).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
  });

test.provider(
  "create and delete a webhook endpoint with minimal props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const endpoint = yield* stack.deploy(
        Stripe.WebhookEndpoint("MinimalEndpoint", {
          url: `${BASE_URL}/minimal`,
          enabledEvents: ["invoice.paid"],
        }),
      );

      expect(endpoint.webhookEndpointId).toBeDefined();
      expect(endpoint.url).toEqual(`${BASE_URL}/minimal`);
      expect(endpoint.enabledEvents).toEqual(["invoice.paid"]);
      expect(endpoint.status).toEqual("enabled");
      expect(endpoint.description).toBeUndefined();
      expect(endpoint.metadata).toEqual({});
      // The signing secret is only ever returned by the create call.
      expect(endpoint.secret).toBeDefined();
      expect(Redacted.value(endpoint.secret!)).toContain("whsec_");

      const fetched = yield* fetchEndpoint(endpoint.webhookEndpointId);
      expect(fetched.url).toEqual(`${BASE_URL}/minimal`);
      expect(fetched.enabled_events).toEqual(["invoice.paid"]);
      expect(fetched.status).toEqual("enabled");
      // Stripe has no tags — ownership is branded into metadata.
      expect(fetched.metadata.alchemy_id).toEqual("MinimalEndpoint");
      expect(fetched.metadata.alchemy_stage).toBeDefined();

      yield* stack.destroy();

      yield* expectGone(endpoint.webhookEndpointId);
    }),
);

test.provider("create a webhook endpoint with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const endpoint = yield* stack.deploy(
      Stripe.WebhookEndpoint("FullEndpoint", {
        url: `${BASE_URL}/full`,
        enabledEvents: [
          "invoice.paid",
          "invoice.payment_failed",
          "customer.subscription.deleted",
        ],
        description: "Alchemy full-surface webhook endpoint",
        apiVersion: "2025-09-30.clover",
        connect: false,
        disabled: true,
        metadata: { team: "billing" },
      }),
    );

    expect(endpoint.url).toEqual(`${BASE_URL}/full`);
    expect([...endpoint.enabledEvents].sort()).toEqual(
      [
        "customer.subscription.deleted",
        "invoice.paid",
        "invoice.payment_failed",
      ].sort(),
    );
    expect(endpoint.description).toEqual(
      "Alchemy full-surface webhook endpoint",
    );
    expect(endpoint.apiVersion).toEqual("2025-09-30.clover");
    expect(endpoint.connect).toEqual(false);
    // `disabled` has no create-time parameter, so reconcile follows the
    // create with an update to converge the status.
    expect(endpoint.status).toEqual("disabled");
    // Internal alchemy_* keys never leak into the user-facing attribute.
    expect(endpoint.metadata).toEqual({ team: "billing" });

    const fetched = yield* fetchEndpoint(endpoint.webhookEndpointId);
    expect(fetched.status).toEqual("disabled");
    expect(fetched.api_version).toEqual("2025-09-30.clover");
    expect(fetched.description).toEqual(
      "Alchemy full-surface webhook endpoint",
    );
    expect(fetched.metadata.team).toEqual("billing");
    expect(fetched.metadata.alchemy_id).toEqual("FullEndpoint");

    yield* stack.destroy();

    yield* expectGone(endpoint.webhookEndpointId);
  }),
);

test.provider(
  "update url, events, description, status and metadata in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.WebhookEndpoint("UpdatableEndpoint", {
          url: `${BASE_URL}/update-before`,
          enabledEvents: ["invoice.paid"],
          description: "before",
          metadata: { phase: "before", dropped: "yes" },
        }),
      );

      expect(created.status).toEqual("enabled");
      expect(created.secret).toBeDefined();

      const updated = yield* stack.deploy(
        Stripe.WebhookEndpoint("UpdatableEndpoint", {
          url: `${BASE_URL}/update-after`,
          enabledEvents: ["invoice.payment_failed", "invoice.paid"],
          disabled: true,
          metadata: { phase: "after" },
        }),
      );

      // Everything here is mutable, so the endpoint keeps its identity —
      // and therefore its signing secret.
      expect(updated.webhookEndpointId).toEqual(created.webhookEndpointId);
      expect(Redacted.value(updated.secret!)).toEqual(
        Redacted.value(created.secret!),
      );
      expect(updated.url).toEqual(`${BASE_URL}/update-after`);
      expect([...updated.enabledEvents].sort()).toEqual([
        "invoice.paid",
        "invoice.payment_failed",
      ]);
      expect(updated.status).toEqual("disabled");
      // An omitted description is unset on Stripe, and metadata keys the
      // user removed are blanked rather than left behind.
      expect(updated.description).toBeUndefined();
      expect(updated.metadata).toEqual({ phase: "after" });

      const fetched = yield* fetchEndpoint(updated.webhookEndpointId);
      expect(fetched.url).toEqual(`${BASE_URL}/update-after`);
      expect(fetched.status).toEqual("disabled");
      expect(fetched.description).toBeNull();
      expect(fetched.metadata.phase).toEqual("after");
      expect(fetched.metadata.dropped).toBeUndefined();

      yield* stack.destroy();

      yield* expectGone(updated.webhookEndpointId);
    }),
);

test.provider(
  "reordering enabledEvents does not change the endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.WebhookEndpoint("StableEventsEndpoint", {
          url: `${BASE_URL}/stable-events`,
          enabledEvents: ["invoice.paid", "invoice.payment_failed"],
        }),
      );

      const redeployed = yield* stack.deploy(
        Stripe.WebhookEndpoint("StableEventsEndpoint", {
          url: `${BASE_URL}/stable-events`,
          enabledEvents: ["invoice.payment_failed", "invoice.paid"],
        }),
      );

      expect(redeployed.webhookEndpointId).toEqual(created.webhookEndpointId);
      expect([...redeployed.enabledEvents].sort()).toEqual([
        "invoice.paid",
        "invoice.payment_failed",
      ]);
      expect(Redacted.value(redeployed.secret!)).toEqual(
        Redacted.value(created.secret!),
      );

      yield* stack.destroy();

      yield* expectGone(created.webhookEndpointId);
    }),
);

test.provider("changing the pinned apiVersion replaces the endpoint", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.WebhookEndpoint("ReplacedEndpoint", {
        url: `${BASE_URL}/replaced`,
        enabledEvents: ["invoice.paid"],
        apiVersion: "2025-09-30.clover",
      }),
    );

    expect(created.apiVersion).toEqual("2025-09-30.clover");

    const replaced = yield* stack.deploy(
      Stripe.WebhookEndpoint("ReplacedEndpoint", {
        url: `${BASE_URL}/replaced`,
        enabledEvents: ["invoice.paid"],
        apiVersion: "2025-10-29.clover",
      }),
    );

    // `api_version` is fixed at creation, so the endpoint is replaced and a
    // brand-new signing secret is minted.
    expect(replaced.webhookEndpointId).not.toEqual(created.webhookEndpointId);
    expect(replaced.apiVersion).toEqual("2025-10-29.clover");
    expect(Redacted.value(replaced.secret!)).not.toEqual(
      Redacted.value(created.secret!),
    );

    yield* expectGone(created.webhookEndpointId);

    const fetched = yield* fetchEndpoint(replaced.webhookEndpointId);
    expect(fetched.api_version).toEqual("2025-10-29.clover");

    yield* stack.destroy();

    yield* expectGone(replaced.webhookEndpointId);
  }),
);

test.provider("list enumerates the deployed webhook endpoint", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Stripe.WebhookEndpoint("ListedEndpoint", {
        url: `${BASE_URL}/listed`,
        enabledEvents: ["invoice.paid"],
      }),
    );

    const provider = yield* Provider.findProvider(Stripe.WebhookEndpoint);
    const all = yield* provider.list();

    const found = all.find(
      (endpoint) => endpoint.webhookEndpointId === deployed.webhookEndpointId,
    );
    expect(found).toBeDefined();
    expect(found!.url).toEqual(`${BASE_URL}/listed`);
    // The secret is unrecoverable from a list call.
    expect(found!.secret).toBeUndefined();

    yield* stack.destroy();

    yield* expectGone(deployed.webhookEndpointId);
  }),
);
