import * as Azure from "@alchemy.run/azure";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, registryLocation as location, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  namespaceName: string,
  certificateAuthorityName: string,
  certificatePolicyName: string,
) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetCertificatePolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      certificateAuthorityName,
      certificatePolicyName,
    });
  });

const program = (props: { name?: string; validityPeriodInDays: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const namespace = yield* Azure.DeviceRegistry.Namespace("Namespace", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const root = yield* Azure.DeviceRegistry.CertificateAuthority("Root", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
    });
    // Policies hang off an issuing (intermediate) CA, not a root.
    const ca = yield* Azure.DeviceRegistry.CertificateAuthority("Intermediate", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      type: "ICA",
      issuer: { type: "Microsoft", certificateAuthorityId: root.certificateAuthorityId },
    });
    const policy = yield* Azure.DeviceRegistry.CertificatePolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      certificateAuthority: ca.certificateAuthorityName,
      name: props.name,
      validityPeriodInDays: props.validityPeriodInDays,
    });
    return { group, namespace, ca, policy };
  });

// Device Registry certificate policies carry no charge; each step
// provisions in about a minute.
test.provider(
  "create, update, replace, and delete a certificate policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, ca, policy } = yield* stack.deploy(
        program({ validityPeriodInDays: 30 }),
      );
      const get = (name: string) =>
        getPolicy(group.resourceGroupName, namespace.namespaceName, ca.certificateAuthorityName, name);
      const observed = yield* get(policy.certificatePolicyName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.certificate?.validityPeriodInDays).toEqual(30);
      expect(policy.validityPeriodInDays).toEqual(30);
      expect(policy.uuid).toMatch(/^[0-9a-f-]{36}$/i);

      // In place: the certificate validity.
      const updated = yield* stack.deploy(program({ validityPeriodInDays: 60 }));
      expect(updated.policy.uuid).toEqual(policy.uuid);
      expect(
        (yield* get(policy.certificatePolicyName)).properties?.certificate?.validityPeriodInDays,
      ).toEqual(60);

      // Replacement: a new name.
      const newName = `${policy.certificatePolicyName.slice(0, 40)}-x`;
      const replaced = yield* stack.deploy(program({ name: newName, validityPeriodInDays: 60 }));
      expect(replaced.policy.certificatePolicyName).toEqual(newName);
      expect(replaced.policy.uuid).not.toEqual(policy.uuid);
      expect(yield* waitGone(get(policy.certificatePolicyName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(newName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
