import * as Azure from "@alchemy.run/azure";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import * as Effect from "effect/Effect";
import { logLevel, registryLocation as location, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCa = (
  resourceGroupName: string,
  namespaceName: string,
  certificateAuthorityName: string,
) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetCertificateAuthority({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      certificateAuthorityName,
    });
  });

// The SDK union also lists the issuer shape; it has no `certificateAuthorityType`.
const caOf = (properties: deviceregistry.CertificateAuthorityProperties | undefined) =>
  properties !== undefined && "certificateAuthorityType" in properties ? properties : undefined;

const icaOf = (properties: deviceregistry.CertificateAuthorityProperties | undefined) => {
  const ca = caOf(properties);
  return ca?.certificateAuthorityType === "ICA" ? ca : undefined;
};

const program = (props: { icaName?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const namespace = yield* Azure.DeviceRegistry.Namespace("Namespace", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const root = yield* Azure.DeviceRegistry.CertificateAuthority("Root", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      tags: props.tags,
    });
    const ica = yield* Azure.DeviceRegistry.CertificateAuthority("Intermediate", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      name: props.icaName,
      type: "ICA",
      issuer: { type: "Microsoft", certificateAuthorityId: root.certificateAuthorityId },
    });
    return { group, namespace, root, ica };
  });

// Device Registry certificate authorities carry no charge; each step
// provisions in about a minute.
test.provider(
  "create, update, replace, and delete certificate authorities",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, root, ica } = yield* stack.deploy(program({ tags: { env: "a" } }));
      const get = (name: string) => getCa(group.resourceGroupName, namespace.namespaceName, name);

      const observedRoot = yield* get(root.certificateAuthorityName);
      expect(caOf(observedRoot.properties)?.provisioningState).toEqual("Succeeded");
      expect(caOf(observedRoot.properties)?.certificateAuthorityType).toEqual("Root");
      expect(caOf(observedRoot.properties)?.keyType).toEqual("ECC");
      expect(observedRoot.tags?.env).toEqual("a");
      expect(observedRoot.tags?.["alchemy::id"]).toEqual("Root");
      expect(root.type).toEqual("Root");
      expect(root.uuid).toMatch(/^[0-9a-f-]{36}$/i);

      const observedIca = yield* get(ica.certificateAuthorityName);
      expect(caOf(observedIca.properties)?.certificateAuthorityType).toEqual("ICA");
      expect(icaOf(observedIca.properties)?.issuer.issuerType).toEqual("Microsoft");
      expect(
        icaOf(observedIca.properties)?.issuer.certificateAuthorityResourceId?.toLowerCase(),
      ).toEqual(root.certificateAuthorityId.toLowerCase());
      expect(ica.issuerType).toEqual("Microsoft");

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "b" } }));
      expect(updated.root.uuid).toEqual(root.uuid);
      expect((yield* get(root.certificateAuthorityName)).tags?.env).toEqual("b");

      // Replacement: a new intermediate name.
      const newName = `${ica.certificateAuthorityName.slice(0, 40)}-x`;
      const replaced = yield* stack.deploy(program({ icaName: newName, tags: { env: "b" } }));
      expect(replaced.ica.certificateAuthorityName).toEqual(newName);
      expect(replaced.ica.uuid).not.toEqual(ica.uuid);
      expect(replaced.root.uuid).toEqual(root.uuid);
      expect(yield* waitGone(get(ica.certificateAuthorityName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(newName))).toEqual("gone");
      expect(yield* waitGone(get(root.certificateAuthorityName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
