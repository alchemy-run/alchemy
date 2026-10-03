import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as management from "@distilled.cloud/azure/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Poll until the group is gone. A deleted group answers reads with 404
 * briefly and then `AuthorizationFailed`; a refused read is settled with a
 * DELETE, which answers `ServiceGroupNameNotFound` once the group is gone
 * (and would only re-delete a group the provider leaked).
 */
const groupGone = (serviceGroupName: string) =>
  management.GetServiceGroup({ serviceGroupName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("AuthorizationFailed", () =>
      management
        .DeleteServiceGroup({ serviceGroupName })
        .pipe(Effect.as("found" as const)),
    ),
    Effect.catchTag(
      ["ResourceNotFound", "ServiceGroupNameNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

/** Read a group until it matches; refused reads are RBAC propagation. */
const observeUntil = (
  serviceGroupName: string,
  matches: (group: management.GetServiceGroupResponse) => boolean,
) =>
  management.GetServiceGroup({ serviceGroupName }).pipe(
    Effect.retry({
      while: (e) => e._tag === "AuthorizationFailed",
      schedule: Schedule.spaced("10 seconds"),
      times: 30,
    }),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: matches,
      times: 24,
    }),
  );

const program = (child: {
  name?: string;
  parent: "A" | "B";
  displayName: string;
  criticality: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const a = yield* Azure.Management.ServiceGroup("ParentA", {
      displayName: "Alchemy test parent A",
    });
    const b = yield* Azure.Management.ServiceGroup("ParentB", {
      displayName: "Alchemy test parent B",
    });
    const group = yield* Azure.Management.ServiceGroup("Child", {
      name: child.name,
      displayName: child.displayName,
      parentId: child.parent === "A" ? a.serviceGroupId : b.serviceGroupName,
      criticality: child.criticality,
      tags: child.tags,
    });
    return { a, b, group };
  });

test.provider(
  "create, update, move, replace and delete a service group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create a nested hierarchy.
      const first = yield* stack.deploy(
        program({
          parent: "A",
          displayName: "Child",
          criticality: 1,
          tags: { team: "alchemy" },
        }),
      );
      const { tenantId } = yield* Azure.AzureEnvironment.current;
      expect(first.a.parentId.toLowerCase()).toEqual(
        `/providers/microsoft.management/servicegroups/${tenantId}`,
      );
      expect(first.group.serviceGroupId).toEqual(
        `/providers/Microsoft.Management/serviceGroups/${first.group.serviceGroupName}`,
      );
      expect(first.group.parentId.toLowerCase()).toEqual(
        first.a.serviceGroupId.toLowerCase(),
      );
      expect(first.group.tags).toEqual({ team: "alchemy" });
      expect(first.group.criticality).toEqual(1);
      const observed = yield* observeUntil(
        first.group.serviceGroupName,
        (g) => g.properties?.displayName === "Child",
      );
      expect(observed.properties?.parent?.resourceId?.toLowerCase()).toEqual(
        first.a.serviceGroupId.toLowerCase(),
      );
      expect(observed.tags?.team).toEqual("alchemy");
      expect(observed.tags?.["alchemy::id"]).toEqual("Child");

      // Update display name, criticality and tags, and move in place.
      const second = yield* stack.deploy(
        program({
          parent: "B",
          displayName: "Child renamed",
          criticality: 2,
          tags: { team: "platform" },
        }),
      );
      expect(second.group.serviceGroupName).toEqual(
        first.group.serviceGroupName,
      );
      expect(second.group.displayName).toEqual("Child renamed");
      expect(second.group.tags).toEqual({ team: "platform" });
      const moved = yield* observeUntil(
        first.group.serviceGroupName,
        (g) =>
          g.properties?.parent?.resourceId?.toLowerCase() ===
            first.b.serviceGroupId.toLowerCase() &&
          g.properties?.displayName === "Child renamed" &&
          g.tags?.team === "platform",
      );
      expect(moved.properties?.parent?.resourceId?.toLowerCase()).toEqual(
        first.b.serviceGroupId.toLowerCase(),
      );
      expect(moved.properties?.attributes?.criticality).toEqual(2);
      expect(moved.tags?.team).toEqual("platform");

      // Changing the name replaces the group.
      const third = yield* stack.deploy(
        program({
          name: "alchemy-test-service-group-replaced",
          parent: "B",
          displayName: "Child replaced",
          criticality: 2,
          tags: { team: "platform" },
        }),
      );
      expect(third.group.serviceGroupName).toEqual(
        "alchemy-test-service-group-replaced",
      );
      const replaced = yield* observeUntil(
        third.group.serviceGroupName,
        (g) => g.properties?.displayName === "Child replaced",
      );
      expect(replaced.properties?.parent?.resourceId?.toLowerCase()).toEqual(
        first.b.serviceGroupId.toLowerCase(),
      );
      expect(yield* groupGone(first.group.serviceGroupName)).toEqual("gone");

      yield* stack.destroy();
      for (const name of [
        third.group.serviceGroupName,
        first.a.serviceGroupName,
        first.b.serviceGroupName,
      ]) {
        expect(yield* groupGone(name)).toEqual("gone");
      }
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:management", "live"],
    timeout: 900_000,
  },
);
