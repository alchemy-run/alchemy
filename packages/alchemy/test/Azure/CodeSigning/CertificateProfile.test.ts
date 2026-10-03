import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as codesigning from "@distilled.cloud/azure/codesigning";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * A certificate profile needs a completed identity validation, which is
 * created in the Azure portal (days of manual review) on an existing account.
 * Supply the account, its resource group, and the validation ID to run the
 * lifecycle.
 */
const identityValidationId =
  process.env.AZURE_TEST_CODESIGNING_IDENTITY_VALIDATION_ID;
const accountName = process.env.AZURE_TEST_CODESIGNING_ACCOUNT_NAME;
const accountGroup = process.env.AZURE_TEST_CODESIGNING_RESOURCE_GROUP;

const getProfile = (
  resourceGroupName: string,
  accountName: string,
  profileName: string,
) =>
  Effect.gen(function* () {
    return yield* codesigning.GetCertificateProfile({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      profileName,
    });
  });

const program = (props: { includeStreetAddress: boolean }) =>
  Effect.gen(function* () {
    // The account holding the identity validation lives outside the stack:
    // deleting it would discard the validation.
    const account = { resourceGroup: accountGroup!, accountName: accountName! };
    const profile = yield* Azure.CodeSigning.CertificateProfile("Release", {
      resourceGroup: account.resourceGroup,
      account: account.accountName,
      profileType: "PublicTrustTest",
      identityValidationId: identityValidationId!,
      includeStreetAddress: props.includeStreetAddress,
    });
    return { account, profile };
  });

// Paid subscription only (Artifact Signing rejects free trials) with an
// existing account ($9.99+/month) and a completed identity validation
// (portal-only). Profiles add no charge: ~$0 per run, ~2-5 minutes.
test.provider.skipIf(
  !runPaidOnly ||
    identityValidationId === undefined ||
    accountName === undefined ||
    accountGroup === undefined,
)(
  "create, replace, and delete a certificate profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { account, profile } = yield* stack.deploy(
        program({ includeStreetAddress: false }),
      );
      expect(profile.profileType).toEqual("PublicTrustTest");
      const observed = yield* getProfile(
        account.resourceGroup,
        account.accountName,
        profile.profileName,
      );
      expect(observed.properties?.identityValidationId).toEqual(
        identityValidationId,
      );
      expect(observed.properties?.includeStreetAddress ?? false).toEqual(false);

      // Replacement: profiles have no update API.
      const replaced = yield* stack.deploy(
        program({ includeStreetAddress: true }),
      );
      expect(replaced.profile.profileName).not.toEqual(profile.profileName);
      const replacedObserved = yield* getProfile(
        account.resourceGroup,
        account.accountName,
        replaced.profile.profileName,
      );
      expect(replacedObserved.properties?.includeStreetAddress).toEqual(true);
      expect(
        yield* waitGone(
          getProfile(
            account.resourceGroup,
            account.accountName,
            profile.profileName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getProfile(
            account.resourceGroup,
            account.accountName,
            replaced.profile.profileName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
