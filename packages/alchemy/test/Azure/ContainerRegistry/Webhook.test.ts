import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  basicRegistry,
  getRegistry,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const where = (
  resourceGroupName: string,
  registryName: string,
  webhookName: string,
) =>
  Effect.map(subscription, (subscriptionId) => ({
    subscriptionId,
    resourceGroupName,
    registryName,
    webhookName,
  }));

const program = (props: {
  name?: string;
  serviceUri: string;
  actions: Azure.ContainerRegistry.WebhookAction[];
  status: "enabled" | "disabled";
  token: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, registry } = yield* basicRegistry();
    const webhook = yield* Azure.ContainerRegistry.Webhook("Hook", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      name: props.name,
      serviceUri: props.serviceUri,
      customHeaders: { Authorization: Redacted.make(props.token) },
      actions: props.actions,
      scope: "app:*",
      status: props.status,
      tags: props.tags,
    });
    return { group, registry, webhook };
  });

// Basic registry (~$0.17/day): well under $1, about a minute.
test.provider(
  "create, update, replace, and delete a webhook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, webhook } = yield* stack.deploy(
        program({
          serviceUri: "https://example.com/hook",
          actions: ["push"],
          status: "enabled",
          token: "Bearer one",
          tags: { env: "test" },
        }),
      );
      const at = (name: string) =>
        where(group.resourceGroupName, registry.registryName, name);
      const get = (name: string) =>
        Effect.flatMap(at(name), containerregistry.GetWebhook);
      expect(webhook.location).toEqual(registry.location);
      const observed = yield* get(webhook.webhookName);
      expect(observed.properties?.actions).toEqual(["push"]);
      expect(observed.properties?.scope).toEqual("app:*");
      expect(observed.tags?.env).toEqual("test");
      const callback = yield* Effect.flatMap(
        at(webhook.webhookName),
        containerregistry.GetWebhookCallbackConfig,
      );
      expect(callback.serviceUri).toEqual("https://example.com/hook");
      expect(callback.customHeaders?.Authorization).toEqual("Bearer one");

      // In-place: endpoint, header, actions, status, and tags.
      const updated = yield* stack.deploy(
        program({
          serviceUri: "https://example.com/hook2",
          actions: ["push", "delete"],
          status: "disabled",
          token: "Bearer two",
          tags: { env: "prod" },
        }),
      );
      expect(updated.webhook.webhookId).toEqual(webhook.webhookId);
      const reobserved = yield* get(webhook.webhookName);
      expect([...(reobserved.properties?.actions ?? [])].sort()).toEqual([
        "delete",
        "push",
      ]);
      expect(reobserved.properties?.status).toEqual("disabled");
      expect(reobserved.tags?.env).toEqual("prod");
      const recallback = yield* Effect.flatMap(
        at(webhook.webhookName),
        containerregistry.GetWebhookCallbackConfig,
      );
      expect(recallback.serviceUri).toEqual("https://example.com/hook2");
      expect(recallback.customHeaders?.Authorization).toEqual("Bearer two");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemywebhooktest",
          serviceUri: "https://example.com/hook2",
          actions: ["push"],
          status: "enabled",
          token: "Bearer two",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.webhook.webhookName).toEqual("alchemywebhooktest");
      yield* get("alchemywebhooktest");
      expect(yield* waitGone(get(webhook.webhookName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
