import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, GONE, PRESENT } from "./compute.ts";

const { test } = makeStackitTest();

// Affinity groups are free placement policies: ungated.
const options = { tags: stackitTags("iaas", "affinitygroup"), timeout: 180_000 } as const;

const presence = (projectId: string, region: string, affinityGroupId: string) =>
  iaas.getAffinityGroup({ projectId, region, affinityGroupId }).pipe(
    Effect.as(PRESENT),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

test.provider(
  "create, replace on a policy change, and delete an affinity group",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.IaaS.AffinityGroup("Group", { policy: "soft-anti-affinity" }),
      );
      expect(created.affinityGroupId).toEqual(expect.any(String));
      expect(created.policy).toEqual("soft-anti-affinity");
      expect(created.members).toEqual([]);

      const fetched = yield* iaas.getAffinityGroup({
        projectId,
        region,
        affinityGroupId: created.affinityGroupId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.policy).toEqual("soft-anti-affinity");

      // A redeploy with the same props keeps the group.
      const unchanged = yield* stack.deploy(
        Stackit.IaaS.AffinityGroup("Group", { policy: "soft-anti-affinity" }),
      );
      expect(unchanged.affinityGroupId).toEqual(created.affinityGroupId);

      // No update API: a policy change replaces the group.
      const replaced = yield* stack.deploy(
        Stackit.IaaS.AffinityGroup("Group", { policy: "soft-affinity" }),
      );
      expect(replaced.affinityGroupId).not.toEqual(created.affinityGroupId);
      expect(replaced.policy).toEqual("soft-affinity");
      yield* expectGone(presence(projectId, region, created.affinityGroupId));

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, replaced.affinityGroupId));
    }).pipe(logLevel),
  options,
);
