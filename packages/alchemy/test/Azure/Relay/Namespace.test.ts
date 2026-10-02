import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { getNamespace, gone, logLevel, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  location: string;
  tags: Record<string, string>;
  minimumTlsVersion: "1.2" | "1.3";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ns = yield* Azure.Relay.Namespace("Relay", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      minimumTlsVersion: props.minimumTlsVersion,
      tags: props.tags,
    });
    return { group, ns };
  });

// Relay Standard namespace: billed per listener/relay hour only, so an idle
// namespace costs ~$0; a few minutes per run.
test.provider(
  "create, update, replace, and delete a relay namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns } = yield* stack.deploy(
        program({
          location: "eastus",
          tags: { env: "test" },
          minimumTlsVersion: "1.2",
        }),
      );
      const rg = group.resourceGroupName;
      expect(ns.namespaceName).toMatch(/^[a-z][a-z0-9-]{4,48}[a-z0-9]$/);
      expect(ns.sku).toEqual("Standard");
      expect(ns.hostName).toEqual(`${ns.namespaceName}.servicebus.windows.net`);
      expect(ns.tags).toEqual({ env: "test" });
      expect(ns.primaryConnectionString).toBeDefined();
      expect(Redacted.value(ns.primaryConnectionString!)).toContain(
        `Endpoint=sb://${ns.namespaceName}.servicebus.windows.net/`,
      );
      const observed = yield* getNamespace(rg, ns.namespaceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.minimumTlsVersion).toEqual("1.2");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Relay");

      // In place: tags and minimum TLS version.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          tags: { env: "prod" },
          minimumTlsVersion: "1.3",
        }),
      );
      expect(updated.ns.namespaceName).toEqual(ns.namespaceName);
      expect(updated.ns.minimumTlsVersion).toEqual("1.3");
      const reobserved = yield* getNamespace(rg, ns.namespaceName);
      expect(reobserved.properties?.minimumTlsVersion).toEqual("1.3");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          tags: { env: "prod" },
          minimumTlsVersion: "1.3",
        }),
      );
      expect(replaced.ns.namespaceName).not.toEqual(ns.namespaceName);
      expect(replaced.ns.location.toLowerCase().replace(/\s/g, "")).toEqual(
        "westus2",
      );
      expect(yield* gone(getNamespace(rg, ns.namespaceName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* gone(getNamespace(rg, replaced.ns.namespaceName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
