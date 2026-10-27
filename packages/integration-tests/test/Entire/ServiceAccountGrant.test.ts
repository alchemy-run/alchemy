import * as Entire from "@alchemy.run/entire";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EntireSdk from "@distilled.cloud/entire";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Entire.providers() });

// Entire caps an account's projects and org creations, and a burst of
// parallel creates leaves projects whose owner grant never lands, so the
// Entire suites take turns.
const opts = { tags: ["provider:entire", "live"], timeout: 180_000, exclusive: "entire:account" };

const app = (role: "reader" | "writer") =>
  Effect.gen(function* () {
    const org = yield* Entire.Org("Org", {});
    const project = yield* Entire.Project("Project", { orgId: org.id });
    const repo = yield* Entire.Repo("Repo", { projectId: project.id });
    const ci = yield* Entire.ServiceAccount("Ci", { orgId: org.id });
    const grant = yield* Entire.ServiceAccountGrant("Grant", {
      accountId: ci.accountId,
      resourceType: "repo",
      resourceId: repo.id,
      role,
    });
    return { ci, repo, grant };
  });

const grantsOf = (accountId: string) =>
  EntireSdk.serviceAccounts
    .listServiceAccountGrants({ accountId })
    .pipe(Effect.map((r) => r.grants.map((g) => ({ resourceId: g.resourceId, role: g.role }))));

test.provider(
  "grant, change role, revoke",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { ci, repo } = yield* stack.deploy(app("reader"));
      expect(yield* grantsOf(ci.accountId)).toContainEqual({ resourceId: repo.id, role: "reader" });

      const updated = yield* stack.deploy(app("writer"));
      expect(updated.grant.role).toEqual("writer");
      const grants = yield* grantsOf(ci.accountId);
      expect(grants).toContainEqual({ resourceId: repo.id, role: "writer" });
      expect(grants).not.toContainEqual({ resourceId: repo.id, role: "reader" });

      yield* stack.destroy();
    }),
  opts,
);
