import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as redis from "@distilled.cloud/gcp/redis_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  redis.getProjectsLocationsAclPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAclPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        redis.getProjectsLocationsAclPolicies({
          name: `projects/${project}/locations/us-central1/aclPolicies/alchemy-acl-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* redis.listProjectsLocationsAclPolicies({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(Array.isArray(page.aclPolicies ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, delete, and GetAclPolicy an ACL policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Redis.AclPolicy("AppAcl", {
            location: "us-central1",
            rules: [{ username: "app", rule: "on ~keys:* +get" }],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* policy.name;
              const getAclPolicy = yield* GCP.Redis.GetAclPolicy(policy);
              return Effect.fn(function* () {
                return yield* getAclPolicy();
              });
            }),
          );
          return { policy, live: yield* Probe({}) };
        }),
      );

      expect(created.policy.name).toContain("/aclPolicies/");
      expect(created.policy.aclPolicyId).toEqual(expect.any(String));
      expect(created.policy.location).toEqual("us-central1");
      expect(created.policy.rules).toEqual([
        { username: "app", rule: "on ~keys:* +get" },
      ]);
      expect(created.live.name).toEqual(created.policy.name);
      expect(
        (created.live.rules ?? []).some(
          (rule) => rule.username === "alchemy-owner",
        ),
      ).toEqual(true);

      const fetched = yield* redis.getProjectsLocationsAclPolicies({
        name: created.policy.name,
      });
      expect(fetched.name).toEqual(created.policy.name);
      expect(
        (fetched.rules ?? []).some((rule) => rule.username === "app"),
      ).toEqual(true);
      expect(
        (fetched.rules ?? []).some((rule) => rule.username === "alchemy-owner"),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Redis.AclPolicy("AppAcl", {
            aclPolicyId: created.policy.aclPolicyId,
            location: "us-central1",
            rules: [
              { username: "app", rule: "on ~keys:* +get +set" },
              { username: "readonly", rule: "off ~* -@all" },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.policy.name);
      expect(updated.rules).toEqual([
        { username: "app", rule: "on ~keys:* +get +set" },
        { username: "readonly", rule: "off ~* -@all" },
      ]);

      const refetched = yield* redis.getProjectsLocationsAclPolicies({
        name: created.policy.name,
      });
      expect(
        (refetched.rules ?? []).some(
          (rule) =>
            rule.username === "app" && (rule.rule ?? "").includes("+set"),
        ),
      ).toEqual(true);
      expect(
        (refetched.rules ?? []).some((rule) => rule.username === "readonly"),
      ).toEqual(true);
      expect(
        (refetched.rules ?? []).some(
          (rule) => rule.username === "alchemy-owner",
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.policy.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
