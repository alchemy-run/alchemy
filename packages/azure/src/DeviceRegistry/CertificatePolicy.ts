import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  DEVICE_REGISTRY_RP,
  DEVICE_REGISTRY_WAIT,
  createDeviceRegistryName,
  listOwnedNamespaces,
  sameName,
} from "./DeviceRegistryShared.ts";

export interface CertificatePolicyProps {
  /** Resource group of the parent namespace. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the parent Device Registry namespace. Changing it replaces the policy. */
  namespace: string;
  /**
   * Name of the issuing (`ICA`) certificate authority that issues under
   * this policy. Changing it replaces the policy.
   */
  certificateAuthority: string;
  /**
   * Policy name: 3-63 letters, digits, and hyphens, starting with a letter
   * or digit. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Validity period, in days, of the certificates issued under this policy.
   * @default Azure's default
   */
  validityPeriodInDays?: number;
}

export interface CertificatePolicy extends Resource<
  "Azure.DeviceRegistry.CertificatePolicy",
  CertificatePolicyProps,
  {
    /** Name of the policy. */
    certificatePolicyName: string;
    /** ARM resource ID of the policy. */
    certificatePolicyId: string;
    /** Name of the parent certificate authority. */
    certificateAuthorityName: string;
    /** Name of the parent namespace. */
    namespaceName: string;
    /** Resource group that holds the parent namespace. */
    resourceGroup: string;
    /** Globally unique, immutable ID Azure assigns to the policy. */
    uuid: string | undefined;
    /** Validity period, in days, of issued certificates. */
    validityPeriodInDays: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A certificate policy
 * (`Microsoft.DeviceRegistry/namespaces/certificateAuthorities/certificatePolicies`)
 * — the issuance rules (certificate validity) an issuing (intermediate)
 * Device Registry certificate authority applies to the device certificates
 * it issues. A root CA cannot hold policies, and an intermediate CA holds
 * at most one.
 *
 * Policies carry no tags, so Alchemy cannot mark them; a policy found
 * under the expected name is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/iot-hub/iot-hub-device-registry-overview
 *
 * :::caution
 * Changing `resourceGroup`, `namespace`, `certificateAuthority`, or `name`
 * replaces the policy. A rename under the same certificate authority
 * deletes the old policy before it creates the new one, so the CA briefly
 * has no policy.
 * :::
 *
 * ### Creating a Certificate Policy
 * **Example:** 30-day device certificates from an intermediate CA
 * ```typescript
 * const ns = yield* Azure.DeviceRegistry.Namespace("devices");
 * const root = yield* Azure.DeviceRegistry.CertificateAuthority("root", {
 *   namespace: ns.namespaceName,
 * });
 * const ica = yield* Azure.DeviceRegistry.CertificateAuthority("ica", {
 *   namespace: ns.namespaceName,
 *   type: "ICA",
 *   issuer: { type: "Microsoft", certificateAuthorityId: root.certificateAuthorityId },
 * });
 * const policy = yield* Azure.DeviceRegistry.CertificatePolicy("devices-30d", {
 *   namespace: ns.namespaceName,
 *   certificateAuthority: ica.certificateAuthorityName,
 *   validityPeriodInDays: 30,
 * });
 * ```
 *
 * @resource
 */
export const CertificatePolicy = GroupedResource<CertificatePolicy>(
  "Azure.DeviceRegistry.CertificatePolicy",
);

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  certificateAuthorityName: string,
  certificatePolicyName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetCertificatePolicy({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      certificateAuthorityName,
      certificatePolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespaceName: string,
  certificateAuthorityName: string,
  name: string,
  observed: deviceregistry.GetCertificatePolicyResponse,
): CertificatePolicy["Attributes"] => ({
  certificatePolicyName: name,
  certificatePolicyId: observed.id ?? "",
  certificateAuthorityName,
  namespaceName,
  resourceGroup,
  uuid: observed.properties?.uuid,
  validityPeriodInDays: observed.properties?.certificate?.validityPeriodInDays,
});

export const CertificatePolicyProvider = () =>
  Provider.succeed(CertificatePolicy, {
    stables: [
      "certificatePolicyName",
      "certificatePolicyId",
      "certificateAuthorityName",
      "namespaceName",
      "resourceGroup",
      "uuid",
    ],

    // Policies have no tags: list those under Alchemy-owned CAs.
    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const namespaces = yield* listOwnedNamespaces(subscriptionId);
      const all: CertificatePolicy["Attributes"][] = [];
      for (const ns of namespaces) {
        const cas = yield* orUndefinedIfNotFound(
          deviceregistry
            .ListCertificateAuthorityByNamespace({
              subscriptionId,
              resourceGroupName: ns.resourceGroup,
              namespaceName: ns.name,
            })
            .pipe(
              Effect.flatMap((page) =>
                requireSinglePage("ListCertificateAuthorityByNamespace", page),
              ),
            ),
        );
        for (const ca of cas?.value ?? []) {
          if (!hasAnyAlchemyTag(ca.tags) || ca.name === undefined) continue;
          const caName = ca.name;
          const policies = yield* orUndefinedIfNotFound(
            deviceregistry
              .ListCertificatePolicyByCertificateAuthority({
                subscriptionId,
                resourceGroupName: ns.resourceGroup,
                namespaceName: ns.name,
                certificateAuthorityName: caName,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListCertificatePolicyByCertificateAuthority", page),
                ),
              ),
          );
          for (const policy of policies?.value ?? []) {
            if (policy.name !== undefined) {
              all.push(toAttrs(ns.resourceGroup, ns.name, caName, policy.name, policy));
            }
          }
        }
      }
      return all;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameParent =
        sameName(news.resourceGroup, output.resourceGroup) &&
        sameName(news.namespace, output.namespaceName) &&
        sameName(news.certificateAuthority, output.certificateAuthorityName);
      if (
        !sameParent ||
        (news.name !== undefined && !sameName(news.name, output.certificatePolicyName))
      ) {
        // A certificate authority holds at most one policy, so a rename
        // under the same CA must delete the old policy first.
        return { action: "replace", deleteFirst: sameParent } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      const caName = output?.certificateAuthorityName ?? olds?.certificateAuthority;
      if (resourceGroup === undefined || namespaceName === undefined || caName === undefined) {
        return undefined;
      }
      const name =
        output?.certificatePolicyName ?? olds?.name ?? (yield* createDeviceRegistryName(id));
      const observed = yield* getPolicy(subscriptionId, resourceGroup, namespaceName, caName, name);
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, namespaceName, caName, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVICE_REGISTRY_RP);
      const resourceGroup = news.resourceGroup;
      const namespaceName = news.namespace;
      const caName = news.certificateAuthority;
      const name =
        news.name ?? output?.certificatePolicyName ?? (yield* createDeviceRegistryName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName,
        certificateAuthorityName: caName,
        certificatePolicyName: name,
      };
      const get = getPolicy(subscriptionId, resourceGroup, namespaceName, caName, name);
      const label = `device registry certificate policy ${namespaceName}/${caName}/${name}`;
      const state = (p: deviceregistry.GetCertificatePolicyResponse) =>
        p.properties?.provisioningState;
      const validity = news.validityPeriodInDays;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* deviceregistry.CertificatePoliciesCreateOrReplace({
          ...where,
          properties: {
            certificate:
              validity === undefined ? undefined : { validityPeriodInDays: validity },
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, state, DEVICE_REGISTRY_WAIT);

      // Sync the certificate validity against observed state.
      if (
        validity !== undefined &&
        observed.properties?.certificate?.validityPeriodInDays !== validity
      ) {
        yield* deviceregistry.UpdateCertificatePolicy({
          ...where,
          properties: { certificate: { validityPeriodInDays: validity } },
        });
        observed = yield* waitForProvisioned(label, get, state, DEVICE_REGISTRY_WAIT);
      }

      return toAttrs(resourceGroup, namespaceName, caName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteCertificatePolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
          certificateAuthorityName: output.certificateAuthorityName,
          certificatePolicyName: output.certificatePolicyName,
        }),
      );
      yield* waitUntilGone(
        `device registry certificate policy ${output.namespaceName}/${output.certificateAuthorityName}/${output.certificatePolicyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
          output.certificateAuthorityName,
          output.certificatePolicyName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DeviceRegistry.Namespace",
        "Azure.DeviceRegistry.CertificateAuthority",
      ],
    },
  });
