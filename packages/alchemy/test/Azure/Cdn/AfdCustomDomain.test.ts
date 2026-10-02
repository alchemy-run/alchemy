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
 * A host name under a domain the tester controls. The domain is never
 * validated (no TXT record is published), so any syntactically valid
 * domain works for the lifecycle.
 */
const domain =
  process.env.AZURE_TEST_FRONTDOOR_DOMAIN ?? "alchemy-test.example.com";

const getDomain = (
  resourceGroupName: string,
  profileName: string,
  customDomainName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetAFDCustomDomain({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      customDomainName,
    });
  });

const program = (props: {
  hostName: string;
  cipherSuiteSetType: "TLS12_2022" | "TLS12_2023";
}) =>
  Effect.gen(function* () {
    const { group, profile } = yield* profileStack;
    const customDomain = yield* Azure.Cdn.AfdCustomDomain("Www", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      hostName: props.hostName,
      tlsSettings: {
        certificateType: "ManagedCertificate",
        cipherSuiteSetType: props.cipherSuiteSetType,
      },
    });
    return { group, profile, customDomain };
  });

// Front Door Standard profile (<$0.10 per run, 10-20 minutes with the profile
// delete). Free Trial subscriptions cannot create Front Door profiles. The
// domain stays in `Pending` validation; the provider does not wait for it.
test.provider.skipIf(!runPaidOnly)(
  "custom domain lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, customDomain } = yield* stack.deploy(
        program({
          hostName: `www.${domain}`,
          cipherSuiteSetType: "TLS12_2022",
        }),
      );
      const get = (name: string) =>
        getDomain(group.resourceGroupName, profile.profileName, name);
      expect(customDomain.hostName).toEqual(`www.${domain}`);
      expect(customDomain.validationToken).toBeDefined();
      const observed = yield* get(customDomain.customDomainName);
      expect(observed.properties?.tlsSettings?.cipherSuiteSetType).toEqual(
        "TLS12_2022",
      );

      // In place: cipher suite set.
      const updated = yield* stack.deploy(
        program({
          hostName: `www.${domain}`,
          cipherSuiteSetType: "TLS12_2023",
        }),
      );
      expect(updated.customDomain.customDomainId).toEqual(
        customDomain.customDomainId,
      );
      const reobserved = yield* get(customDomain.customDomainName);
      expect(reobserved.properties?.tlsSettings?.cipherSuiteSetType).toEqual(
        "TLS12_2023",
      );

      // Replacement: the host name is immutable.
      const replaced = yield* stack.deploy(
        program({
          hostName: `app.${domain}`,
          cipherSuiteSetType: "TLS12_2023",
        }),
      );
      expect(replaced.customDomain.hostName).toEqual(`app.${domain}`);
      expect(replaced.customDomain.customDomainId).not.toEqual(
        customDomain.customDomainId,
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.customDomain.customDomainName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
