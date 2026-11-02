import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  expectGone,
  observeCredential,
  observeInstance,
  PLAN,
  slow,
  VERSION,
} from "./opensearch.ts";

const { test } = makeStackitTest();

const app = (rotationKey?: string) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.OpenSearch.Instance("CredentialInstance", {
      version: VERSION,
      planName: PLAN,
      acl: [CLOSED_ACL],
    });
    return yield* Stackit.OpenSearch.Credential("AppCredential", {
      instanceId: instance.instanceId,
      ...(rotationKey === undefined ? {} : { rotationKey }),
    });
  });

test.provider.skipIf(slow)(
  "create, read, rotate and delete a credential",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app());
      expect(created.credentialId).toEqual(expect.any(String));
      expect(created.username.length).toBeGreaterThan(0);
      expect(created.host.length).toBeGreaterThan(0);
      expect(Redacted.isRedacted(created.password)).toBe(true);
      expect(Redacted.isRedacted(created.uri)).toBe(true);
      expect(created.hosts.length).toBeGreaterThan(0);

      // Out of band: the credential exists, with the same user.
      const fetched = yield* opensearch.getCredentials({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
        credentialsId: created.credentialId,
      });
      expect(fetched.raw?.credentials.username).toEqual(created.username);

      const listed = yield* opensearch.listCredentials({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(listed.credentialsList.map((item) => item.id)).toContain(created.credentialId);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app());
      expect(plan.resources.AppCredential).toMatchObject({ action: "noop" });

      // A new rotation key makes a new credential and deletes the old one.
      const rotated = yield* stack.deploy(app("2026-11"));
      expect(rotated.credentialId).not.toEqual(created.credentialId);
      expect(rotated.instanceId).toEqual(created.instanceId);
      yield* expectGone(
        observeCredential(projectId, region, created.instanceId, created.credentialId),
      );

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  { tags: stackitTags("opensearch", "credential"), timeout: 2_700_000 },
);
