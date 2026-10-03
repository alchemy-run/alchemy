import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cdn from "@distilled.cloud/azure/cdn";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  FRONT_DOOR_TIMEOUT,
  logLevel,
  profileStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * ARM ID of a Key Vault certificate secret
 * (`/subscriptions/.../vaults/<vault>/secrets/<cert>`) that the Front Door
 * service principal (app `205478c0-bd83-4e1b-a9d6-db63a3e1e1c8`) can read.
 * Granting Front Door access to a vault is a tenant-level setup step, so the
 * test takes a prepared certificate.
 */
const certificateSecretId = process.env.AZURE_TEST_FRONTDOOR_CERT_SECRET_ID;

const getSecret = (
  resourceGroupName: string,
  profileName: string,
  secretName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetSecret({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      secretName,
    });
  });

const program = (props: { useLatestVersion: boolean }) =>
  Effect.gen(function* () {
    const { group, profile } = yield* profileStack;
    const secret = yield* Azure.Cdn.Secret("Cert", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      parameters: {
        type: "CustomerCertificate",
        secretSourceId: certificateSecretId!,
        useLatestVersion: props.useLatestVersion,
      },
    });
    return { group, profile, secret };
  });

// Front Door Standard profile (<$0.10 per run, 10-20 minutes with the profile
// delete). Free Trial subscriptions cannot create Front Door profiles, and the
// test needs a prepared Key Vault certificate. Secrets cannot be updated, so
// a parameter change is a replacement.
test.provider.skipIf(!runPaidOnly || !certificateSecretId)(
  "secret lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, secret } = yield* stack.deploy(
        program({ useLatestVersion: true }),
      );
      const get = (name: string) =>
        getSecret(group.resourceGroupName, profile.profileName, name);
      expect(secret.type).toEqual("CustomerCertificate");
      const observed = yield* get(secret.secretName);
      expect(observed.properties?.parameters?.useLatestVersion).toEqual(true);

      // Replacement: parameters are immutable.
      const replaced = yield* stack.deploy(
        program({ useLatestVersion: false }),
      );
      expect(replaced.secret.secretId).not.toEqual(secret.secretId);
      const reobserved = yield* get(replaced.secret.secretName);
      expect(reobserved.properties?.parameters?.useLatestVersion).toEqual(
        false,
      );

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.secret.secretName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
