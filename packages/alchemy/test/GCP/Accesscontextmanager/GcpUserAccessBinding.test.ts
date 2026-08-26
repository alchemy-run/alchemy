import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  logLevel,
  projectContext,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const GROUP_KEY = "01d520gv4vjcrht";

const waitUntilGone = (name: string) =>
  acm.getOrganizationsGcpUserAccessBindings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsGcpUserAccessBindings on a missing binding fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ctx = yield* projectContext();
      const organization = ctx.organization ?? "organizations/0";
      const error = yield* Effect.flip(
        acm.getOrganizationsGcpUserAccessBindings({
          name: `${organization}/gcpUserAccessBindings/alchemy-missing-binding`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a gcp user access binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ctx = yield* projectContext();
      const scopes =
        ctx.projectNumber.length > 0
          ? [`projects/${ctx.projectNumber}`]
          : undefined;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Accesscontextmanager.AccessPolicy(
            "BindingPolicy",
            {
              title: "user access binding policy",
              scopes,
            },
          );
          const level =
            yield* GCP.Accesscontextmanager.AccessPoliciesAccessLevel(
              "Trusted",
              {
                policy: policy.name,
                title: "trusted devices",
                basic: { conditions: [{ regions: ["US"] }] },
              },
            );
          const binding = yield* GCP.Accesscontextmanager.GcpUserAccessBinding(
            "Engineers",
            {
              organization: ctx.organization,
              groupKey: GROUP_KEY,
              accessLevels: [level.name],
            },
          );
          return { policy, level, binding };
        }),
      );

      expect(created.binding.name).toContain("/gcpUserAccessBindings/");
      expect(created.binding.groupKey).toEqual(GROUP_KEY);
      expect(created.binding.accessLevels).toContain(created.level.name);

      const fetched = yield* acm.getOrganizationsGcpUserAccessBindings({
        name: created.binding.name,
      });
      expect(fetched.name).toEqual(created.binding.name);
      expect(fetched.groupKey).toEqual(GROUP_KEY);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Accesscontextmanager.AccessPolicy(
            "BindingPolicy",
            {
              title: "user access binding policy",
              scopes,
            },
          );
          const level =
            yield* GCP.Accesscontextmanager.AccessPoliciesAccessLevel(
              "Trusted",
              {
                policy: policy.name,
                accessLevelId: created.level.accessLevelId,
                title: "trusted devices",
                basic: { conditions: [{ regions: ["US"] }] },
              },
            );
          const binding = yield* GCP.Accesscontextmanager.GcpUserAccessBinding(
            "Engineers",
            {
              organization: ctx.organization,
              groupKey: GROUP_KEY,
              accessLevels: [level.name],
              dryRunAccessLevels: [level.name],
            },
          );
          return { policy, level, binding };
        }),
      );

      expect(updated.binding.name).toEqual(created.binding.name);
      expect(updated.binding.dryRunAccessLevels).toContain(created.level.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.binding.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
