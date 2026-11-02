import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, instanceProps, observeCredential, slow } from "./valkey.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("valkey", "credential"),
  timeout: 2_700_000,
} as const;

const app = (rotationKey?: string) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Valkey.Instance("CredentialInstance", instanceProps());
    const credential = yield* Stackit.Valkey.Credential("AppCredential", {
      instanceId: instance.instanceId,
      rotationKey,
    });
    return { instance, credential };
  });

test.provider.skipIf(slow)(
  "create, redeploy, rotate and delete a credential",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region: regionId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(app());
      expect(first.credential.instanceId).toEqual(first.instance.instanceId);
      expect(first.credential.host.length).toBeGreaterThan(0);
      expect(first.credential.username.length).toBeGreaterThan(0);
      expect(Redacted.value(first.credential.password).length).toBeGreaterThan(0);
      expect(Redacted.value(first.credential.uri).length).toBeGreaterThan(0);

      // Out of band: the credential exists with the same connection details.
      const fetched = yield* valkey.getCredentials({
        projectId,
        regionId,
        instanceId: first.instance.instanceId,
        credentialsId: first.credential.credentialId,
      });
      expect(fetched.raw?.credentials.username).toEqual(first.credential.username);
      expect(fetched.raw?.credentials.host).toEqual(first.credential.host);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app());
      expect(plan.resources.AppCredential).toMatchObject({ action: "noop" });

      // A new rotation key replaces it: new id, and the old credential is gone.
      const rotated = yield* stack.deploy(app("2026-11"));
      expect(rotated.credential.credentialId).not.toEqual(first.credential.credentialId);
      expect(rotated.instance.instanceId).toEqual(first.instance.instanceId);
      yield* expectGone(
        observeCredential(
          projectId,
          regionId,
          first.instance.instanceId,
          first.credential.credentialId,
        ),
      );
      const listed = yield* valkey.listCredentials({
        projectId,
        regionId,
        instanceId: first.instance.instanceId,
      });
      expect(listed.credentialsList.map((item) => item.id)).toContain(
        rotated.credential.credentialId,
      );

      yield* stack.destroy();
      yield* expectGone(
        observeCredential(
          projectId,
          regionId,
          first.instance.instanceId,
          rotated.credential.credentialId,
        ),
      );
    }).pipe(logLevel),
  options,
);
