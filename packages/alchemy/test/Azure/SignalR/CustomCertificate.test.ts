import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as signalr from "@distilled.cloud/azure/signalr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { certificateStack } from "./fixtures/certificate-stack.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  resourceName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    return yield* signalr.GetSignalRCustomCertificate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      certificateName,
    });
  });

const program = (props: { secret: "A" | "B"; pinVersion: boolean }) =>
  Effect.gen(function* () {
    const base = yield* certificateStack;
    const secret = base.secrets[props.secret];
    const certificate = yield* Azure.SignalR.CustomCertificate("Tls", {
      resourceGroup: base.group.resourceGroupName,
      signalR: base.signalRName,
      keyVaultBaseUri: base.vault.vaultUri,
      keyVaultSecretName: secret.secretName,
      keyVaultSecretVersion: props.pinVersion
        ? secret.secretUriWithVersion.pipe(
            Output.map((uri) => uri.split("/").pop()!),
          )
        : undefined,
    });
    return { ...base, secret, certificate };
  });

// Premium_P1 unit (~$0.08/hour) for ~10 minutes, a vault and two secrets:
// well under $0.05 per run.
test.provider(
  "create, update, replace, and delete a SignalR custom certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, secret, certificate } = yield* stack.deploy(
        program({ secret: "A", pinVersion: false }),
      );
      const get = (name: string) =>
        getCertificate(group.resourceGroupName, service.signalRName, name);
      expect(certificate.keyVaultSecretName).toEqual(secret.secretName);
      const observed = yield* get(certificate.certificateName);
      expect(observed.properties.keyVaultSecretName).toEqual(secret.secretName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");

      // In place: pin the secret version.
      const updated = yield* stack.deploy(
        program({ secret: "A", pinVersion: true }),
      );
      expect(updated.certificate.certificateId).toEqual(
        certificate.certificateId,
      );
      const reobserved = yield* get(certificate.certificateName);
      expect(reobserved.properties.keyVaultSecretVersion).toBeDefined();
      expect(updated.secret.secretUriWithVersion).toContain(
        reobserved.properties.keyVaultSecretVersion!,
      );

      // Replacement: the secret name is immutable.
      const replaced = yield* stack.deploy(
        program({ secret: "B", pinVersion: false }),
      );
      expect(replaced.certificate.certificateName).not.toEqual(
        certificate.certificateName,
      );
      const replacedObserved = yield* get(replaced.certificate.certificateName);
      expect(replacedObserved.properties.keyVaultSecretName).toEqual(
        replaced.secret.secretName,
      );
      expect(yield* waitGone(get(certificate.certificateName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          signalr.GetSignalR({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            resourceName: service.signalRName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
