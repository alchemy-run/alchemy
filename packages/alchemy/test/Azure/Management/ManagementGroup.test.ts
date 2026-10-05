import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as management from "@distilled.cloud/azure/management";
import { expect } from "alchemy-test";
import { runExpensive } from "../gates.ts";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const groupGone = (groupId: string) =>
  management.GetManagementGroup({ groupId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ManagementGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    // Reads of a just-deleted group can be refused for a while.
    Effect.catchTag("AuthorizationFailed", () =>
      Effect.succeed("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
    // GET answers 404 as soon as an asynchronous DELETE is accepted, even
    // if that delete later fails and the group reappears: require the
    // absence to hold for ~30s.
    Effect.flatMap((status) =>
      status === "gone"
        ? management.GetManagementGroup({ groupId }).pipe(
            Effect.as("found" as const),
            Effect.catchTag(["ManagementGroupNotFound", "NotFound"], () =>
              Effect.succeed("gone" as const),
            ),
            Effect.catchTag("AuthorizationFailed", () =>
              Effect.succeed("gone" as const),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              while: (s) => s === "gone",
              times: 6,
            }),
          )
        : Effect.succeed(status),
    ),
  );

/**
 * Read a group until it matches. Reads are cached per ARM front end, and
 * the creator's Owner grant reaches each front end at a different time, so
 * a read can be refused (`AuthorizationFailed`) after another succeeded.
 */
const observeUntil = (
  groupId: string,
  matches: (group: management.GetManagementGroupResponse) => boolean,
) =>
  management.GetManagementGroup({ groupId }).pipe(
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
}) =>
  Effect.gen(function* () {
    const a = yield* Azure.Management.ManagementGroup("ParentA", {
      displayName: "Alchemy test parent A",
    });
    const b = yield* Azure.Management.ManagementGroup("ParentB", {
      displayName: "Alchemy test parent B",
    });
    const group = yield* Azure.Management.ManagementGroup("Child", {
      name: child.name,
      displayName: child.displayName,
      parentId: child.parent === "A" ? a.managementGroupId : b.groupName,
    });
    return { a, b, group };
  });

// Free ($0), but slow: the creator's implicit Owner grant on a new
// management group takes seconds to ~8 minutes to propagate through ARM when
// the deploying identity has no role on the tenant root group, and the group
// is unusable (reads/writes refused) until then. Whole lifecycle ~7-15 min.
test.provider.skipIf(!runExpensive)(
  "create, rename, move, replace and delete a management group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create a nested hierarchy.
      const first = yield* stack.deploy(
        program({ parent: "A", displayName: "Child" }),
      );
      const { tenantId } = yield* Azure.AzureEnvironment.current;
      expect(first.a.tenantId).toEqual(tenantId);
      expect(first.a.parentId.toLowerCase()).toEqual(
        `/providers/microsoft.management/managementgroups/${tenantId}`,
      );
      expect(first.group.managementGroupId).toEqual(
        `/providers/Microsoft.Management/managementGroups/${first.group.groupName}`,
      );
      expect(first.group.parentId.toLowerCase()).toEqual(
        first.a.managementGroupId.toLowerCase(),
      );
      const observed = yield* observeUntil(
        first.group.groupName,
        (g) => g.properties?.displayName === "Child",
      );
      expect(observed.properties?.details?.parent?.name).toEqual(
        first.a.groupName,
      );

      // Rename and move in place.
      const second = yield* stack.deploy(
        program({ parent: "B", displayName: "Child renamed" }),
      );
      expect(second.group.groupName).toEqual(first.group.groupName);
      expect(second.group.displayName).toEqual("Child renamed");
      const moved = yield* observeUntil(
        first.group.groupName,
        (g) =>
          g.properties?.details?.parent?.name === first.b.groupName &&
          g.properties?.displayName === "Child renamed",
      );
      expect(moved.properties?.details?.parent?.name).toEqual(
        first.b.groupName,
      );
      expect(moved.properties?.displayName).toEqual("Child renamed");

      // Changing the name replaces the group.
      const third = yield* stack.deploy(
        program({
          name: "alchemy-test-management-group-replaced",
          parent: "B",
          displayName: "Child replaced",
        }),
      );
      expect(third.group.groupName).toEqual(
        "alchemy-test-management-group-replaced",
      );
      const replaced = yield* observeUntil(
        third.group.groupName,
        (g) => g.properties?.displayName === "Child replaced",
      );
      expect(replaced.properties?.details?.parent?.name).toEqual(
        first.b.groupName,
      );
      expect(yield* groupGone(first.group.groupName)).toEqual("gone");

      yield* stack.destroy();
      for (const name of [
        third.group.groupName,
        first.a.groupName,
        first.b.groupName,
      ]) {
        expect(yield* groupGone(name)).toEqual("gone");
      }
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:management", "live"],
    timeout: 1_800_000,
  },
);
