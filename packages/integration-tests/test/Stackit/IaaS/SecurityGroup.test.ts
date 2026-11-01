import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Security groups are free, so the suite is ungated.
const options = { tags: stackitTags("iaas", "securitygroup"), timeout: 300_000 } as const;

const observe = (projectId: string, region: string, securityGroupId: string) =>
  iaas
    .getSecurityGroup({ projectId, region, securityGroupId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (projectId: string, region: string, securityGroupId: string) =>
  observe(projectId, region, securityGroupId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (group) => group === "gone",
      times: 10,
    }),
    Effect.map((group) => expect(group).toEqual("gone")),
  );

test.provider(
  "create, update and delete a security group",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.IaaS.SecurityGroup("Web", {
          description: "web servers",
          labels: { env: "test" },
        }),
      );
      expect(created.securityGroupId).toEqual(expect.any(String));
      expect(created.stateful).toEqual(true);
      expect(created.description).toEqual("web servers");
      expect(created.labels).toEqual({ env: "test" });

      const fetched = yield* iaas.getSecurityGroup({
        projectId,
        region,
        securityGroupId: created.securityGroupId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.stateful).toEqual(true);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        "alchemy.id": "Web",
      });

      const updated = yield* stack.deploy(
        Stackit.IaaS.SecurityGroup("Web", {
          name: "alchemy-iaas-sg-renamed",
          description: "web servers, renamed",
          labels: { env: "prod" },
        }),
      );
      expect(updated.securityGroupId).toEqual(created.securityGroupId);
      expect(updated.name).toEqual("alchemy-iaas-sg-renamed");

      const refetched = yield* iaas.getSecurityGroup({
        projectId,
        region,
        securityGroupId: created.securityGroupId,
      });
      expect(refetched.name).toEqual("alchemy-iaas-sg-renamed");
      expect(refetched.description).toEqual("web servers, renamed");
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // `stateful` cannot change in place.
      const replaced = yield* stack.deploy(
        Stackit.IaaS.SecurityGroup("Web", {
          name: "alchemy-iaas-sg-renamed",
          stateful: false,
          labels: { env: "prod" },
        }),
      );
      expect(replaced.securityGroupId).not.toEqual(created.securityGroupId);
      expect(replaced.stateful).toEqual(false);
      yield* expectGone(projectId, region, created.securityGroupId);

      yield* stack.destroy();
      yield* expectGone(projectId, region, replaced.securityGroupId);
    }).pipe(logLevel),
  options,
);
