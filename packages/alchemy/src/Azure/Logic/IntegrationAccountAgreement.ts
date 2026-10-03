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

/** A partner's business identity used in an agreement. */
export interface IntegrationAccountAgreementIdentity {
  /** Identity qualifier, e.g. `ZZ`, `AS2Identity`. */
  qualifier: string;
  /** Identity value. */
  value: string;
}

/** Message protocol of an agreement. */
export type IntegrationAccountAgreementType = "AS2" | "X12" | "Edifact";

export interface IntegrationAccountAgreementProps {
  /** Resource group of the integration account. Changing it replaces the agreement. */
  resourceGroup: string;
  /** Name of the integration account. Changing it replaces the agreement. */
  integrationAccount: string;
  /**
   * Agreement name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the agreement.
   */
  name?: string;
  /** Message protocol. Changing it replaces the agreement. */
  agreementType: IntegrationAccountAgreementType;
  /** Name of the host partner (the integration account's own business). */
  hostPartner: string;
  /** Name of the guest partner. */
  guestPartner: string;
  /** Business identity of the host partner; must be one of its identities. */
  hostIdentity: IntegrationAccountAgreementIdentity;
  /** Business identity of the guest partner; must be one of its identities. */
  guestIdentity: IntegrationAccountAgreementIdentity;
  /**
   * Protocol settings: `{ aS2: { receiveAgreement, sendAgreement } }`,
   * `{ x12: ... }`, or `{ edifact: ... }` as documented for the protocol.
   */
  content: logic.AgreementContent;
  /**
   * User metadata. Alchemy adds `alchemy::*` ownership and hash keys
   * because artifacts do not return tags.
   */
  metadata?: Record<string, unknown>;
}

export interface IntegrationAccountAgreement extends Resource<
  "Azure.Logic.IntegrationAccountAgreement",
  IntegrationAccountAgreementProps,
  {
    /** Name of the agreement. */
    agreementName: string;
    /** Name of the integration account. */
    integrationAccount: string;
    /** Resource group of the integration account. */
    resourceGroup: string;
    /** ARM resource ID of the agreement. */
    agreementId: string;
    /** Message protocol. */
    agreementType: string;
    /** Name of the host partner. */
    hostPartner: string;
    /** Name of the guest partner. */
    guestPartner: string;
    /** Time the agreement was last changed. */
    changedTime: string | undefined;
    /** User metadata (Alchemy keys stripped). */
    metadata: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * A B2B agreement between a host and a guest partner in a Logic Apps
 * integration account. It carries the AS2, X12, or EDIFACT settings the
 * B2B encode/decode actions apply to messages exchanged by the partners.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-enterprise-integration-agreements
 *
 * ### Creating an Agreement
 * **Example:** AS2 agreement between two partners
 * ```typescript
 * const agreement = yield* Azure.Logic.IntegrationAccountAgreement("as2", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   agreementType: "AS2",
 *   hostPartner: contoso.partnerName,
 *   guestPartner: fabrikam.partnerName,
 *   hostIdentity: { qualifier: "ZZ", value: "CONTOSO" },
 *   guestIdentity: { qualifier: "ZZ", value: "FABRIKAM" },
 *   content: {
 *     aS2: {
 *       receiveAgreement: { senderBusinessIdentity, receiverBusinessIdentity, protocolSettings },
 *       sendAgreement: { senderBusinessIdentity, receiverBusinessIdentity, protocolSettings },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccountAgreement =
  Resource<IntegrationAccountAgreement>(
    "Azure.Logic.IntegrationAccountAgreement",
  );

const getAgreement = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
  agreementName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccountAgreement({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
      agreementName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  integrationAccount: string,
  name: string,
  observed: logic.GetIntegrationAccountAgreementResponse,
): IntegrationAccountAgreement["Attributes"] => ({
  agreementName: name,
  integrationAccount,
  resourceGroup,
  agreementId: observed.id ?? "",
  agreementType: observed.properties.agreementType,
  hostPartner: observed.properties.hostPartner,
  guestPartner: observed.properties.guestPartner,
  changedTime: observed.properties.changedTime,
  metadata: userMetadata(observed.properties.metadata),
});

export const IntegrationAccountAgreementProvider = () =>
  Provider.succeed(IntegrationAccountAgreement, {
    stables: [
      "agreementName",
      "integrationAccount",
      "resourceGroup",
      "agreementId",
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
          news.name.toLowerCase() !== output.agreementName.toLowerCase()) ||
        news.agreementType.toLowerCase() !== output.agreementType.toLowerCase()
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
        output?.agreementName ?? olds?.name ?? (yield* createLogicName(id));
      const observed = yield* getAgreement(
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
        news.name ?? output?.agreementName ?? (yield* createLogicName(id));
      const properties = {
        agreementType: news.agreementType,
        hostPartner: news.hostPartner,
        guestPartner: news.guestPartner,
        hostIdentity: news.hostIdentity,
        guestIdentity: news.guestIdentity,
        content: news.content,
      };
      const metadata = yield* artifactMetadata(id, news.metadata, {
        [HASH_KEY]: yield* hashOf({ properties, metadata: news.metadata }),
      });

      // Observe.
      let observed = yield* getAgreement(
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
            agreementType: properties.agreementType,
            hostPartner: properties.hostPartner,
            guestPartner: properties.guestPartner,
            hostIdentity: properties.hostIdentity,
            guestIdentity: properties.guestIdentity,
          }),
        )
      ) {
        observed = yield* logic.IntegrationAccountAgreementsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          integrationAccountName: integrationAccount,
          agreementName: name,
          properties: { ...properties, metadata },
        });
      }

      return toAttrs(resourceGroup, integrationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccountAgreement({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccount,
          agreementName: output.agreementName,
        }),
      );
      yield* waitUntilGone(
        `integration account agreement ${output.agreementName}`,
        getAgreement(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccount,
          output.agreementName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Logic.IntegrationAccount"] },
  });
