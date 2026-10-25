import { resolveAzureCredentials } from "@alchemy.run/azure/Credentials";
import * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import * as servicePrincipals from "@distilled.cloud/microsoft-graph/servicePrincipals";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { SECURITY_DOMAIN_KEYS } from "./security-domain-keys.ts";

/** Object ID of the deployer's service principal (an HSM's initial administrator). */
export const deployerObjectId = Effect.gen(function* () {
  const creds = yield* yield* resolveAzureCredentials;
  const deployer = yield* servicePrincipals.getServicePrincipalByAppId({
    appId: creds.clientId,
    select: ["id"],
  });
  expect(deployer.id).toMatch(/^[0-9a-f-]{36}$/);
  return deployer.id ?? "";
});

/**
 * Activate a managed HSM whose initial administrator is the deployer:
 * download its security domain (encrypted to the checked-in test keys) and
 * wait until the download reports `Success`.
 */
export const activateHsm = (managedHsmName: string) =>
  Effect.gen(function* () {
    const vaultBaseUrl = `https://${managedHsmName}.managedhsm.azure.net`;
    const downloaded = yield* securityDomain.DownloadHSMSecurityDomain({
      vaultBaseUrl,
      certificates: SECURITY_DOMAIN_KEYS,
      required: 2,
    });
    expect(downloaded.value?.length ?? 0).toBeGreaterThan(0);
    const status = yield* securityDomain.DownloadHSMSecurityDomainPending({ vaultBaseUrl }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (s) => s.status !== "InProgress",
        times: 30,
      }),
    );
    expect(status.status).toEqual("Success");
  });
