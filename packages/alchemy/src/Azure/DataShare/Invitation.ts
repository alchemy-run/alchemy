import { isResolved } from "../../Diff.ts";
import * as datashare from "@distilled.cloud/azure/datashare";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOwnedByStack,
  createChildName,
  immutableChanged,
} from "./internal.ts";

export interface InvitationProps {
  /** Resource group of the Data Share account. Changing it replaces the invitation. */
  resourceGroup: string;
  /** Data Share account that offers the share. Changing it replaces the invitation. */
  account: string;
  /** Share the invitation grants access to. Changing it replaces the invitation. */
  share: string;
  /**
   * Invitation name: letters, digits, and `_`, starting with a letter. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the invitation.
   */
  name?: string;
  /**
   * Email address the invitation is sent to. Mutually exclusive with
   * `targetActiveDirectoryId`/`targetObjectId`. Changing it replaces the
   * invitation.
   */
  targetEmail?: string;
  /**
   * Microsoft Entra tenant of the recipient. Set together with
   * `targetObjectId` to invite a user or service principal without
   * sending an email. Changing it replaces the invitation.
   */
  targetActiveDirectoryId?: string;
  /**
   * Object ID of the user or service principal invited. Requires
   * `targetActiveDirectoryId`. Changing it replaces the invitation.
   */
  targetObjectId?: string;
  /**
   * ISO 8601 time after which the invitation and any share subscription
   * created from it expire. Changing it replaces the invitation.
   */
  expirationDate?: string;
}

export interface Invitation extends Resource<
  "Azure.DataShare.Invitation",
  InvitationProps,
  {
    /** Name of the invitation. */
    invitationName: string;
    /** Share the invitation grants access to. */
    shareName: string;
    /** Data Share account that offers the share. */
    accountName: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the invitation. */
    invitationArmId: string;
    /**
     * Unique invitation ID. Pass it to a consumer's
     * `Azure.DataShare.ShareSubscription` to accept the invitation.
     */
    invitationId: string;
    /** `Pending`, `Accepted`, `Rejected`, or `Withdrawn`. */
    invitationStatus: string;
    /** Time the invitation was sent. */
    sentAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An invitation to an Azure Data Share share. The recipient accepts it by
 * creating a share subscription in their own Data Share account with the
 * invitation's `invitationId`. Deleting a pending invitation revokes it.
 *
 * @see https://learn.microsoft.com/azure/data-share/share-your-data#create-a-share
 *
 * ### Inviting a Consumer
 * **Example:** Invite by email
 * ```typescript
 * yield* Azure.DataShare.Invitation("partner", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   share: share.shareName,
 *   targetEmail: "data@partner.example",
 * });
 * ```
 *
 * **Example:** Invite a service principal without email
 * ```typescript
 * const invitation = yield* Azure.DataShare.Invitation("pipeline", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   share: share.shareName,
 *   targetActiveDirectoryId: tenantId,
 *   targetObjectId: pipelinePrincipalId,
 * });
 * ```
 *
 * @resource
 */
export const Invitation = Resource<Invitation>("Azure.DataShare.Invitation");

type ObservedInvitation =
  | datashare.GetInvitationResponse
  | datashare.CreateInvitationResponse;

const getInvitation = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  shareName: string,
  invitationName: string,
) =>
  orUndefinedIfNotFound(
    datashare.GetInvitation({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareName,
      invitationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  accountName: string,
  shareName: string,
  name: string,
  invitation: ObservedInvitation,
): Invitation["Attributes"] => ({
  invitationName: name,
  shareName,
  accountName,
  resourceGroup,
  invitationArmId: invitation.id ?? "",
  invitationId: invitation.properties?.invitationId ?? "",
  invitationStatus: invitation.properties?.invitationStatus ?? "Pending",
  sentAt: invitation.properties?.sentAt,
});

export const InvitationProvider = () =>
  Provider.succeed(Invitation, {
    stables: [
      "invitationName",
      "shareName",
      "accountName",
      "resourceGroup",
      "invitationArmId",
      "invitationId",
    ],

    // Invitations vanish with their share; the account carries the ownership tags.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Every prop is immutable; an unresolved one comes from an upstream
      // resource being created or replaced.
      // An unresolved props object comes from an upstream replacement; every
      // prop is immutable, so that is a replace.
      if (!isResolved(news))
        return { action: "replace", deleteFirst: true } as const;
      const next = news;
      const ci = { caseInsensitive: true };
      if (
        immutableChanged(next.resourceGroup, output.resourceGroup, ci) ||
        immutableChanged(next.account, output.accountName, ci) ||
        immutableChanged(next.share, output.shareName, ci) ||
        (next.name !== undefined &&
          immutableChanged(next.name, output.invitationName, ci)) ||
        (olds !== undefined &&
          (immutableChanged(next.targetEmail, olds.targetEmail) ||
            immutableChanged(
              next.targetActiveDirectoryId,
              olds.targetActiveDirectoryId,
            ) ||
            immutableChanged(next.targetObjectId, olds.targetObjectId) ||
            immutableChanged(next.expirationDate, olds.expirationDate)))
      ) {
        // A share holds one pending invitation per recipient.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.accountName ?? olds?.account;
      const share = output?.shareName ?? olds?.share;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        share === undefined
      ) {
        return undefined;
      }
      const name =
        output?.invitationName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getInvitation(
        subscriptionId,
        resourceGroup,
        account,
        share,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, share, name, observed);
      return (yield* accountOwnedByStack(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataShare");
      const { resourceGroup, account, share } = news;
      const name =
        news.name ?? output?.invitationName ?? (yield* createChildName(id));
      const get = getInvitation(
        subscriptionId,
        resourceGroup,
        account,
        share,
        name,
      );

      // Observe. Invitations are immutable: every prop change replaces.
      const observed = yield* get;
      if (observed !== undefined) {
        return toAttrs(resourceGroup, account, share, name, observed);
      }

      // Ensure. The PUT is synchronous.
      const created = yield* datashare.CreateInvitation({
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        shareName: share,
        invitationName: name,
        properties: {
          targetEmail: news.targetEmail,
          targetActiveDirectoryId: news.targetActiveDirectoryId,
          targetObjectId: news.targetObjectId,
          expirationDate: news.expirationDate,
        },
      });
      return toAttrs(resourceGroup, account, share, name, created);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datashare.DeleteInvitation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
          shareName: output.shareName,
          invitationName: output.invitationName,
        }),
      );
      yield* waitUntilGone(
        `data share invitation ${output.invitationName}`,
        getInvitation(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
          output.shareName,
          output.invitationName,
        ),
        { interval: "3 seconds", times: 40 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DataShare.Account"],
    },
  });
