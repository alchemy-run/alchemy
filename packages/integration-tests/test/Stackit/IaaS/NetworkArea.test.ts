import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Network areas are free and need organization-level IaaS permissions for
// the test service account (and an organization id in the profile).
const options = { tags: stackitTags("iaas", "networkarea"), timeout: 300_000 } as const;

const observe = (organizationId: string, areaId: string) =>
  iaas
    .getNetworkArea({ organizationId, areaId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (organizationId: string, areaId: string) =>
  observe(organizationId, areaId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (area) => area === "gone",
      times: 10,
    }),
    Effect.map((area) => expect(area).toEqual("gone")),
  );

test.provider(
  "create, rename, relabel, replace and delete a network area",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      const organizationId = env.organizationId ?? "";
      expect(organizationId).not.toEqual("");
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.IaaS.NetworkArea("Corp", { labels: { env: "test" } }),
      );
      expect(created.networkAreaId).toEqual(expect.any(String));
      expect(created.organizationId).toEqual(organizationId);
      expect(created.routingTables).toEqual(false);
      expect(created.labels).toEqual({ env: "test" });

      const fetched = yield* iaas.getNetworkArea({
        organizationId,
        areaId: created.networkAreaId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        "alchemy.id": "Corp",
      });

      const updated = yield* stack.deploy(
        Stackit.IaaS.NetworkArea("Corp", {
          name: "alchemy-iaas-area-renamed",
          labels: { env: "prod" },
        }),
      );
      expect(updated.networkAreaId).toEqual(created.networkAreaId);
      const refetched = yield* iaas.getNetworkArea({
        organizationId,
        areaId: created.networkAreaId,
      });
      expect(refetched.name).toEqual("alchemy-iaas-area-renamed");
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // The routing tables preview can only be chosen at creation.
      const replaced = yield* stack.deploy(
        Stackit.IaaS.NetworkArea("Corp", {
          name: "alchemy-iaas-area-renamed",
          routingTables: true,
          labels: { env: "prod" },
        }),
      );
      expect(replaced.networkAreaId).not.toEqual(created.networkAreaId);
      expect(replaced.routingTables).toEqual(true);
      expect(replaced.labels).toEqual({ env: "prod" });
      yield* expectGone(organizationId, created.networkAreaId);

      yield* stack.destroy();
      yield* expectGone(organizationId, replaced.networkAreaId);
    }).pipe(logLevel),
  options,
);
