import * as datashare from "@distilled.cloud/azure/datashare";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOwnedByStack,
  createChildName,
  immutableChanged,
} from "./internal.ts";

export interface ShareSubscriptionProps {
  /** Resource group of the consumer Data Share account. Changing it replaces the subscription. */
  resourceGroup: string;
  /** Consumer Data Share account that receives the share. Changing it replaces the subscription. */
  account: string;
  /**
   * Share subscription name: letters, digits, and `_`, starting with a
   * letter. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the subscription.
   */
  name?: string;
  /**
   * `invitationId` of the invitation being accepted (see
   * `Azure.DataShare.Invitation`). The invitation must target the deploying
   * identity. Changing it replaces the subscription.
   */
  invitationId: string;
  /**
   * Location of the provider's Data Share account (the source share).
   * Changing it replaces the subscription.
   */
  sourceShareLocation: string;
  /**
   * ISO 8601 time after which the subscription expires. Changing it
   * replaces the subscription.
   */
  expirationDate?: string;
}

export interface ShareSubscription extends Resource<
  "Azure.DataShare.ShareSubscription",
  ShareSubscriptionProps,
  {
    /** Name of the share subscription. */
    shareSubscriptionName: string;
    /** Consumer Data Share account. */
    accountName: string;
    /** Resource group of the consumer account. */
    resourceGroup: string;
    /** ARM resource ID of the share subscription. */
    shareSubscriptionId: string;
    /** Invitation the subscription accepted. */
    invitationId: string;
    /** `Active`, `Revoked`, `SourceDeleted`, or `Revoking`. */
    shareSubscriptionStatus: string;
    /** Name of the source share. */
    shareName: string | undefined;
    /** Kind of the source share (`CopyBased` or `InPlace`). */
    shareKind: string | undefined;
    /** Name of the provider who created the share. */
    providerName: string | undefined;
    /** Tenant of the provider who created the share. */
    providerTenantName: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string;
  },
  never,
  Providers
> {}

/**
 * A share subscription — the consumer side of Azure Data Share. Creating it
 * in your Data Share account accepts an invitation; map the received data
 * sets into your own stores with `Azure.DataShare.DataSetMapping` and
 * schedule snapshots with `Azure.DataShare.Trigger`. Deleting it stops
 * receiving the share.
 *
 * @see https://learn.microsoft.com/azure/data-share/subscribe-to-data-share
 *
 * ### Accepting an Invitation
 * **Example:** Subscribe to a share
 * ```typescript
 * const subscription = yield* Azure.DataShare.ShareSubscription("inbound", {
 *   resourceGroup: consumerGroup.resourceGroupName,
 *   account: consumerAccount.accountName,
 *   invitationId: invitation.invitationId,
 *   sourceShareLocation: providerAccount.location,
 * });
 * ```
 *
 * @resource
 */
export const ShareSubscription = Resource<ShareSubscription>(
  "Azure.DataShare.ShareSubscription",
);

type ObservedSubscription =
  | datashare.GetShareSubscriptionResponse
  | datashare.CreateShareSubscriptionResponse;

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  shareSubscriptionName: string,
) =>
  orUndefinedIfNotFound(
    datashare.GetShareSubscription({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareSubscriptionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  accountName: string,
  name: string,
  subscription: ObservedSubscription,
): ShareSubscription["Attributes"] => ({
  shareSubscriptionName: name,
  accountName,
  resourceGroup,
  shareSubscriptionId: subscription.id ?? "",
  invitationId: subscription.properties.invitationId,
  shareSubscriptionStatus:
    subscription.properties.shareSubscriptionStatus ?? "Active",
  shareName: subscription.properties.shareName,
  shareKind: subscription.properties.shareKind,
  providerName: subscription.properties.providerName,
  providerTenantName: subscription.properties.providerTenantName,
  provisioningState: subscription.properties.provisioningState ?? "Succeeded",
});

export const ShareSubscriptionProvider = () =>
  Provider.succeed(ShareSubscription, {
    stables: [
      "shareSubscriptionName",
      "accountName",
      "resourceGroup",
      "shareSubscriptionId",
      "invitationId",
    ],

    // Share subscriptions vanish with their account; the account carries the
    // ownership tags.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Every prop is immutable; an unresolved one comes from an upstream
      // resource being created or replaced.
      const next = news as unknown as Record<
        keyof ShareSubscriptionProps,
        unknown
      >;
      const ci = { caseInsensitive: true };
      if (
        immutableChanged(next.resourceGroup, output.resourceGroup, ci) ||
        immutableChanged(next.account, output.accountName, ci) ||
        (next.name !== undefined &&
          immutableChanged(next.name, output.shareSubscriptionName, ci)) ||
        immutableChanged(next.invitationId, output.invitationId) ||
        (olds !== undefined &&
          (immutableChanged(
            next.sourceShareLocation,
            olds.sourceShareLocation,
            ci,
          ) ||
            immutableChanged(next.expirationDate, olds.expirationDate)))
      ) {
        // An invitation is accepted by one share subscription.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.accountName ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.shareSubscriptionName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getSubscription(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* accountOwnedByStack(subscriptionId, resourceGroup, account))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataShare");
      const { resourceGroup, account } = news;
      const name =
        news.name ??
        output?.shareSubscriptionName ??
        (yield* createChildName(id));
      const get = getSubscription(subscriptionId, resourceGroup, account, name);

      // Observe. Share subscriptions are immutable: every prop change replaces.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* datashare.CreateShareSubscription({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          shareSubscriptionName: name,
          properties: {
            invitationId: news.invitationId,
            sourceShareLocation: news.sourceShareLocation,
            expirationDate: news.expirationDate,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `data share subscription ${name}`,
        get,
        (subscription) => subscription.properties.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datashare.DeleteShareSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
          shareSubscriptionName: output.shareSubscriptionName,
        }),
      );
      yield* waitUntilGone(
        `data share subscription ${output.shareSubscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
          output.shareSubscriptionName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DataShare.Account"],
    },
  });
