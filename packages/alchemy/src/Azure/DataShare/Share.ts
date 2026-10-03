import * as datashare from "@distilled.cloud/azure/datashare";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import { accountOwnedByStack, createChildName, sameName } from "./internal.ts";

export type ShareKind = "CopyBased" | "InPlace";

export interface ShareProps {
  /** Resource group of the Data Share account. Changing it replaces the share. */
  resourceGroup: string;
  /** Data Share account that offers the share. Changing it replaces the share. */
  account: string;
  /**
   * Share name: letters, digits, and `_`, starting with a letter, at most
   * 90 characters. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the share.
   */
  name?: string;
  /**
   * `CopyBased` shares snapshot data into the consumer's store; `InPlace`
   * shares (Azure Data Explorer) grant in-place access. Changing it
   * replaces the share.
   * @default "CopyBased"
   */
  shareKind?: ShareKind;
  /** Description shown to consumers. */
  description?: string;
  /** Terms of use consumers must accept. */
  terms?: string;
}

export interface Share extends Resource<
  "Azure.DataShare.Share",
  ShareProps,
  {
    /** Name of the share. */
    shareName: string;
    /** Data Share account that offers the share. */
    accountName: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the share. */
    shareId: string;
    /** Share kind (`CopyBased` or `InPlace`). */
    shareKind: string;
    /** Description shown to consumers. */
    description: string | undefined;
    /** Terms of use. */
    terms: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string;
    /** Time the share was created. */
    createdAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A share in an Azure Data Share account — the unit of data a provider
 * offers to consumers. Add data sets and a synchronization schedule to the
 * share, then invite consumers with an invitation.
 *
 * Shares carry no tags; Alchemy treats a share as owned when its account
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/data-share/share-your-data
 *
 * ### Creating a Share
 * **Example:** Snapshot-based share
 * ```typescript
 * const share = yield* Azure.DataShare.Share("sales", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   description: "Daily sales extracts",
 *   terms: "Internal use only",
 * });
 * ```
 *
 * @resource
 */
export const Share = Resource<Share>("Azure.DataShare.Share");

type ObservedShare = datashare.GetShareResponse | datashare.CreateShareResponse;

const getShare = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  shareName: string,
) =>
  orUndefinedIfNotFound(
    datashare.GetShare({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  accountName: string,
  name: string,
  share: ObservedShare,
): Share["Attributes"] => ({
  shareName: name,
  accountName,
  resourceGroup,
  shareId: share.id ?? "",
  shareKind: share.properties?.shareKind ?? "CopyBased",
  description: share.properties?.description,
  terms: share.properties?.terms,
  provisioningState: share.properties?.provisioningState ?? "Succeeded",
  createdAt: share.properties?.createdAt,
});

export const ShareProvider = () =>
  Provider.succeed(Share, {
    stables: ["shareName", "accountName", "resourceGroup", "shareId"],

    // Shares vanish with their account; the account carries the ownership tags.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.account, output.accountName) ||
        (news.name !== undefined && !sameName(news.name, output.shareName)) ||
        (news.shareKind ?? "CopyBased") !== output.shareKind
      ) {
        return { action: "replace" } as const;
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
        output?.shareName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getShare(
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
      const resourceGroup = news.resourceGroup;
      const account = news.account;
      const name =
        news.name ?? output?.shareName ?? (yield* createChildName(id));
      const shareKind = news.shareKind ?? "CopyBased";
      const get = getShare(subscriptionId, resourceGroup, account, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is an upsert, so one call creates the share
      // or converges its description and terms.
      if (
        observed === undefined ||
        (observed.properties?.description ?? undefined) !== news.description ||
        (observed.properties?.terms ?? undefined) !== news.terms
      ) {
        yield* datashare.CreateShare({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          shareName: name,
          properties: {
            shareKind,
            description: news.description,
            terms: news.terms,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `data share ${name}`,
        get,
        (share) => share.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datashare.DeleteShare({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
          shareName: output.shareName,
        }),
      );
      yield* waitUntilGone(
        `data share ${output.shareName}`,
        getShare(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
          output.shareName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DataShare.Account"],
    },
  });
