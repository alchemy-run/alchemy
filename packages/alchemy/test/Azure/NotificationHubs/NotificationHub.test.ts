import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  getHub,
  getNamespace,
  gone,
  logLevel,
  namespaceProgram,
  tags,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  registrationTtl: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, ns } = yield* namespaceProgram;
    const hub = yield* Azure.NotificationHubs.NotificationHub("Hub", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      name: props.name,
      registrationTtl: props.registrationTtl,
      tags: props.tags,
    });
    return { group, ns, hub };
  });

// Free namespace + hub without credentials: $0; a few minutes.
test.provider(
  "create, update, replace, and delete a notification hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, hub } = yield* stack.deploy(
        program({ registrationTtl: "90.00:00:00", tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(hub.notificationHubName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(hub.registrationTtl).toEqual("90.00:00:00");
      expect(hub.tags).toEqual({ env: "test" });
      expect(hub.location.toLowerCase().replace(/\s/g, "")).toEqual(
        ns.location.toLowerCase().replace(/\s/g, ""),
      );
      const observed = yield* getHub(
        rg,
        ns.namespaceName,
        hub.notificationHubName,
      );
      expect(observed.properties?.registrationTtl).toEqual("90.00:00:00");
      expect(observed.tags?.["alchemy::id"]).toEqual("Hub");

      // In place: registration TTL and tags.
      const updated = yield* stack.deploy(
        program({ registrationTtl: "30.00:00:00", tags: { env: "prod" } }),
      );
      expect(updated.hub.notificationHubName).toEqual(hub.notificationHubName);
      const reobserved = yield* getHub(
        rg,
        ns.namespaceName,
        hub.notificationHubName,
      );
      expect(reobserved.properties?.registrationTtl).toEqual("30.00:00:00");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-renamed-hub",
          registrationTtl: "30.00:00:00",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.hub.notificationHubName).toEqual("alchemy-renamed-hub");
      expect(
        yield* gone(getHub(rg, ns.namespaceName, hub.notificationHubName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* gone(getNamespace(rg, ns.namespaceName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
