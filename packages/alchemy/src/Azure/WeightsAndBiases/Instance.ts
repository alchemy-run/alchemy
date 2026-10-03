import * as wandb from "@distilled.cloud/azure/liftrweightsandbiases";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** The Azure Marketplace offer the W&B instance subscribes to. */
export interface WeightsAndBiasesOfferDetails {
  /** Marketplace publisher ID, e.g. `wandb`. */
  publisherId: string;
  /** Marketplace offer ID, e.g. `wandb-pay-as-you-go`. */
  offerId: string;
  /** Marketplace plan ID, e.g. `wandb-payg`. */
  planId: string;
  /** Display name of the plan. */
  planName?: string;
  /** Billing term unit of the plan, e.g. `P1M`. */
  termUnit?: string;
  /** Billing term ID of the plan. */
  termId?: string;
}

/** Azure Marketplace purchase details of the instance. */
export interface WeightsAndBiasesMarketplace {
  /**
   * Azure subscription ID the Marketplace offer is purchased from.
   * @default the deployment subscription
   */
  subscriptionId?: string;
  /** The Marketplace offer and plan. */
  offerDetails: WeightsAndBiasesOfferDetails;
}

/** The W&B organization owner. */
export interface WeightsAndBiasesUser {
  /** First name of the user. */
  firstName?: string;
  /** Last name of the user. */
  lastName?: string;
  /** Email address of the user. */
  emailAddress: string;
  /** User principal name (Entra ID UPN) of the user. */
  upn?: string;
  /** Phone number of the user. */
  phoneNumber?: string;
}

/** Single sign-on settings of the instance. */
export interface WeightsAndBiasesSingleSignOn {
  /** SSO mechanism, `Saml` or `OpenId`. */
  type: "Saml" | "OpenId";
  /**
   * State of single sign-on.
   * @default "Enable"
   */
  state?: "Initial" | "Enable" | "Disable";
  /** ID of the Entra ID enterprise application used for SSO. */
  enterpriseAppId?: string;
  /** URL W&B redirects users to for SSO. */
  url?: string;
  /** Entra ID domains allowed to sign in. */
  aadDomains?: string[];
}

/** Managed identity of the instance. */
export interface WeightsAndBiasesIdentity {
  /** Kind of managed identity. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM resource IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

export interface InstanceProps {
  /**
   * Resource group the instance is created in. Changing it replaces the
   * instance.
   */
  resourceGroup: string;
  /**
   * Name of the instance resource. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the instance.
   */
  name?: string;
  /**
   * Azure location of the instance resource. Changing it replaces the
   * instance.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Azure Marketplace offer to subscribe to. Changing it replaces the
   * instance.
   */
  marketplace: WeightsAndBiasesMarketplace;
  /** The W&B organization owner. Changing it replaces the instance. */
  user: WeightsAndBiasesUser;
  /**
   * W&B region hosting the dedicated instance: `eastus`, `centralus`,
   * `westus`, `westeurope`, `japaneast`, or `koreacentral`. Changing it
   * replaces the instance.
   * @default the instance location
   */
  region?: string;
  /**
   * Subdomain of the instance (`https://<subdomain>.wandb.io`). Changing it
   * replaces the instance.
   * @default the lowercase instance name
   */
  subdomain?: string;
  /** Single sign-on settings. */
  singleSignOn?: WeightsAndBiasesSingleSignOn;
  /**
   * Managed identity of the instance.
   * @default no managed identity
   */
  identity?: WeightsAndBiasesIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Instance extends Resource<
  "Azure.WeightsAndBiases.Instance",
  InstanceProps,
  {
    /** Name of the instance resource. */
    instanceName: string;
    /** Resource group that holds the instance. */
    resourceGroup: string;
    /** ARM resource ID of the instance. */
    instanceId: string;
    /** Location of the instance resource. */
    location: string;
    /** W&B region hosting the instance. */
    region: string | undefined;
    /** Subdomain of the instance. */
    subdomain: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Status of the Marketplace SaaS subscription, e.g. `Subscribed`. */
    marketplaceSubscriptionStatus: string | undefined;
    /** Principal ID of the system-assigned managed identity. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dedicated Weights & Biases instance provisioned as an Azure Native ISV
 * Service (`Microsoft.WeightsAndBiases/instances`). Creating it subscribes to
 * the W&B offer through Azure Marketplace; deleting it cancels the SaaS
 * subscription.
 *
 * The subscription must allow Marketplace purchases (free trial and
 * sponsored subscriptions cannot) and have accepted the W&B Marketplace
 * terms.
 *
 * @see https://learn.microsoft.com/azure/partner-solutions/weights-biases/overview
 *
 * ### Creating an Instance
 * **Example:** Pay-as-you-go W&B instance
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ml", {
 *   location: "eastus",
 * });
 * const wandb = yield* Azure.WeightsAndBiases.Instance("wandb", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   marketplace: {
 *     offerDetails: {
 *       publisherId: "wandb",
 *       offerId: "wandb-pay-as-you-go",
 *       planId: "wandb-payg",
 *     },
 *   },
 *   user: { emailAddress: "ml-platform@example.com" },
 *   subdomain: "acme-ml",
 * });
 * ```
 *
 * ### Single Sign-On and Identity
 * **Example:** Entra ID SSO with a system-assigned identity
 * ```typescript
 * const wandb = yield* Azure.WeightsAndBiases.Instance("wandb", {
 *   resourceGroup: group.resourceGroupName,
 *   marketplace,
 *   user: { emailAddress: "ml-platform@example.com" },
 *   singleSignOn: { type: "OpenId", enterpriseAppId: appId },
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const Instance = Resource<Instance>("Azure.WeightsAndBiases.Instance");

type ObservedInstance = wandb.GetInstanceResponse;

const createInstanceName = (id: string) =>
  createPhysicalName({ id, maxLength: 50 });

const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Stable JSON for order-insensitive comparison of plain objects. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );

const getInstance = (
  subscriptionId: string,
  resourceGroupName: string,
  instancename: string,
) =>
  orUndefinedIfNotFound(
    wandb.GetInstance({ subscriptionId, resourceGroupName, instancename }),
  );

const waitForInstance = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) =>
  waitForProvisioned(
    `W&B instance ${name}`,
    getInstance(subscriptionId, resourceGroup, name),
    (instance) => instance.properties?.provisioningState,
    { interval: "10 seconds", times: 60 },
  );

const subdomainOf = (props: InstanceProps, name: string) =>
  props.subdomain ?? name.toLowerCase();

const desiredSso = (sso: WeightsAndBiasesSingleSignOn | undefined) =>
  sso === undefined
    ? undefined
    : {
        type: sso.type,
        state: sso.state ?? "Enable",
        enterpriseAppId: sso.enterpriseAppId,
        url: sso.url,
        aadDomains: sso.aadDomains,
      };

const ssoDiffers = (
  observed: wandb.LiftrBaseSingleSignOnPropertiesV2 | undefined,
  desired: ReturnType<typeof desiredSso>,
) => {
  if (desired === undefined) return false;
  return (
    observed?.type !== desired.type ||
    observed?.state !== desired.state ||
    (desired.enterpriseAppId !== undefined &&
      observed?.enterpriseAppId !== desired.enterpriseAppId) ||
    (desired.url !== undefined && observed?.url !== desired.url) ||
    (desired.aadDomains !== undefined &&
      canonicalJson([...(observed?.aadDomains ?? [])].sort()) !==
        canonicalJson([...desired.aadDomains].sort()))
  );
};

const desiredIdentity = (identity: WeightsAndBiasesIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined ||
          identity.userAssignedIdentities.length === 0
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

const identityDiffers = (
  observed: wandb.GetInstanceResponseIdentity | undefined,
  desired: WeightsAndBiasesIdentity | undefined,
) => {
  if (desired === undefined) return false;
  const observedType = observed?.type ?? "None";
  if (observedType.replace(/\s/g, "") !== desired.type) return true;
  const observedIds = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const desiredIds = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return canonicalJson(observedIds) !== canonicalJson(desiredIds);
};

/** Create-only properties, normalized for comparison. */
const createOnly = (props: InstanceProps) => ({
  marketplace: {
    subscriptionId: props.marketplace.subscriptionId,
    offerDetails: props.marketplace.offerDetails,
  },
  user: props.user,
  region: props.region,
  subdomain: props.subdomain,
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedInstance,
): Instance["Attributes"] => ({
  instanceName: name,
  resourceGroup,
  instanceId: observed.id ?? "",
  location: observed.location,
  region: observed.properties?.partnerProperties?.region,
  subdomain: observed.properties?.partnerProperties?.subdomain,
  provisioningState: observed.properties?.provisioningState,
  marketplaceSubscriptionStatus:
    observed.properties?.marketplace?.subscriptionStatus,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceName", "resourceGroup", "instanceId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* wandb
        .ListInstanceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListInstanceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((instance) => {
        const group = resourceGroupOf(instance.id);
        return hasAnyAlchemyTag(instance.tags) &&
          group !== undefined &&
          instance.name !== undefined
          ? [toAttrs(group, instance.name, instance)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.instanceName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        (news.region !== undefined &&
          output.region !== undefined &&
          !sameName(news.region, output.region)) ||
        (news.subdomain !== undefined &&
          output.subdomain !== undefined &&
          !sameName(news.subdomain, output.subdomain))
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        canonicalJson(createOnly(olds)) !== canonicalJson(createOnly(news))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.instanceName ?? olds?.name ?? (yield* createInstanceName(id));
      const observed = yield* getInstance(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.WeightsAndBiases");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.instanceName ?? (yield* createInstanceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sso = desiredSso(news.singleSignOn);

      // The full PUT body; create-only fields come from the props, so a
      // re-PUT only changes the mutable single sign-on settings.
      const put = () =>
        wandb.InstancesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          instancename: name,
          location,
          tags,
          identity: desiredIdentity(news.identity),
          properties: {
            marketplace: {
              subscriptionId: news.marketplace.subscriptionId ?? subscriptionId,
              offerDetails: news.marketplace.offerDetails,
            },
            user: news.user,
            partnerProperties: {
              region: news.region ?? location,
              subdomain: subdomainOf(news, name),
            },
            singleSignOnProperties: sso,
          },
        });

      // Observe.
      let observed = yield* getInstance(subscriptionId, resourceGroup, name);

      // Ensure: the PUT subscribes to the Marketplace offer and provisions
      // the dedicated instance in the background.
      if (observed === undefined) {
        yield* put();
      }
      observed = yield* waitForInstance(subscriptionId, resourceGroup, name);

      // Sync single sign-on (PUT-only) against the observed instance.
      if (ssoDiffers(observed.properties?.singleSignOnProperties, sso)) {
        yield* put();
        observed = yield* waitForInstance(subscriptionId, resourceGroup, name);
      }

      // Sync tags and identity (PATCH) against the observed instance.
      const syncTags = tagsDiffer(observed.tags, tags);
      const syncIdentity = identityDiffers(observed.identity, news.identity);
      if (syncTags || syncIdentity) {
        yield* wandb.UpdateInstance({
          subscriptionId,
          resourceGroupName: resourceGroup,
          instancename: name,
          tags: syncTags ? tags : undefined,
          identity: syncIdentity ? desiredIdentity(news.identity) : undefined,
        });
        observed = yield* waitForInstance(subscriptionId, resourceGroup, name);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        wandb.DeleteInstance({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          instancename: output.instanceName,
        }),
      );
      yield* waitUntilGone(
        `W&B instance ${output.instanceName}`,
        getInstance(subscriptionId, output.resourceGroup, output.instanceName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
