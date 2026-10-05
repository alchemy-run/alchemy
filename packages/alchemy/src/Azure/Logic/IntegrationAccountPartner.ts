import * as logic from "@distilled.cloud/azure/logic";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  artifactDiffers,
  artifactMetadata,
  createLogicName,
  definedOnly,
  HASH_KEY,
  hashOf,
  isOwnedByMetadata,
  userMetadata,
} from "./LogicShared.ts";

/** A business identity of a trading partner. */
export interface IntegrationAccountBusinessIdentity {
  /** Identity qualifier, e.g. `ZZ`, `ZZZ`, `AS2Identity`, `01`. */
  qualifier: string;
  /** Identity value. */
  value: string;
}

export interface IntegrationAccountPartnerProps {
  /** Resource group of the integration account. Changing it replaces the partner. */
  resourceGroup: string;
  /** Name of the integration account. Changing it replaces the partner. */
  integrationAccount: string;
  /**
   * Partner name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the partner.
   */
  name?: string;
  /** Business identities that identify the partner in B2B messages. */
  businessIdentities: IntegrationAccountBusinessIdentity[];
  /**
   * Partner type.
   * @default "B2B"
   */
  partnerType?: "B2B";
  /**
   * User metadata. Alchemy adds `alchemy::*` ownership and hash keys
   * because artifacts do not return tags.
   */
  metadata?: Record<string, unknown>;
}

export interface IntegrationAccountPartner extends Resource<
  "Azure.Logic.IntegrationAccountPartner",
  IntegrationAccountPartnerProps,
  {
    /** Name of the partner. */
    partnerName: string;
    /** Name of the integration account. */
    integrationAccount: string;
    /** Resource group of the integration account. */
    resourceGroup: string;
    /** ARM resource ID of the partner. */
    partnerId: string;
    /** Business identities of the partner. */
    businessIdentities: IntegrationAccountBusinessIdentity[];
    /** Time the partner was last changed. */
    changedTime: string | undefined;
    /** User metadata (Alchemy keys stripped). */
    metadata: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * A B2B trading partner in a Logic Apps integration account, identified
 * by one or more business identities. Agreements are made between two
 * partners.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-enterprise-integration-partners
 *
 * ### Adding Partners
 * **Example:** Host and guest partners
 * ```typescript
 * const contoso = yield* Azure.Logic.IntegrationAccountPartner("contoso", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   businessIdentities: [{ qualifier: "ZZ", value: "CONTOSO" }],
 * });
 * const fabrikam = yield* Azure.Logic.IntegrationAccountPartner("fabrikam", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   businessIdentities: [{ qualifier: "ZZ", value: "FABRIKAM" }],
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccountPartner = Resource<IntegrationAccountPartner>(
  "Azure.Logic.IntegrationAccountPartner",
);

const getPartner = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
  partnerName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccountPartner({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
      partnerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  integrationAccount: string,
  name: string,
  observed: logic.GetIntegrationAccountPartnerResponse,
): IntegrationAccountPartner["Attributes"] => ({
  partnerName: name,
  integrationAccount,
  resourceGroup,
  partnerId: observed.id ?? "",
  businessIdentities: (
    observed.properties.content.b2b?.businessIdentities ?? []
  ).map(({ qualifier, value }) => ({ qualifier, value })),
  changedTime: observed.properties.changedTime,
  metadata: userMetadata(observed.properties.metadata),
});

export const IntegrationAccountPartnerProvider = () =>
  Provider.succeed(IntegrationAccountPartner, {
    stables: [
      "partnerName",
      "integrationAccount",
      "resourceGroup",
      "partnerId",
    ],

    // Artifacts live inside an integration account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.integrationAccount.toLowerCase() !==
          output.integrationAccount.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.partnerName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const integrationAccount =
        output?.integrationAccount ?? olds?.integrationAccount;
      if (resourceGroup === undefined || integrationAccount === undefined) {
        return undefined;
      }
      const name =
        output?.partnerName ?? olds?.name ?? (yield* createLogicName(id));
      const observed = yield* getPartner(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, integrationAccount, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Logic");
      const { resourceGroup, integrationAccount } = news;
      const name =
        news.name ?? output?.partnerName ?? (yield* createLogicName(id));
      const properties = {
        partnerType: news.partnerType ?? "B2B",
        content: { b2b: { businessIdentities: news.businessIdentities } },
      };
      const metadata = yield* artifactMetadata(id, news.metadata, {
        [HASH_KEY]: yield* hashOf({ properties, metadata: news.metadata }),
      });

      // Observe.
      let observed = yield* getPartner(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full replacement; changes
      // to fields Azure does not echo surface through the metadata hash.
      if (
        observed === undefined ||
        artifactDiffers(
          observed.properties,
          metadata,
          definedOnly({
            partnerType: properties.partnerType,
            content: properties.content,
          }),
        )
      ) {
        observed = yield* logic.IntegrationAccountPartnersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          integrationAccountName: integrationAccount,
          partnerName: name,
          properties: { ...properties, metadata },
        });
      }

      return toAttrs(resourceGroup, integrationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccountPartner({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccount,
          partnerName: output.partnerName,
        }),
      );
      yield* waitUntilGone(
        `integration account partner ${output.partnerName}`,
        getPartner(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccount,
          output.partnerName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Logic.IntegrationAccount"] },
  });
