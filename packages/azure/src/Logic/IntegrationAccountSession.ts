import * as logic from "@distilled.cloud/azure/logic";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createLogicName, hashOf } from "./LogicShared.ts";

export interface IntegrationAccountSessionProps {
  /** Resource group of the integration account. Changing it replaces the session. */
  resourceGroup: string;
  /** Name of the integration account. Changing it replaces the session. */
  integrationAccount: string;
  /**
   * Session name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the session.
   */
  name?: string;
  /** JSON content of the session, stored and returned as given. */
  content: Record<string, unknown>;
}

export interface IntegrationAccountSession extends Resource<
  "Azure.Logic.IntegrationAccountSession",
  IntegrationAccountSessionProps,
  {
    /** Name of the session. */
    sessionName: string;
    /** Name of the integration account. */
    integrationAccount: string;
    /** Resource group of the integration account. */
    resourceGroup: string;
    /** ARM resource ID of the session. */
    sessionId: string;
    /** JSON content of the session as stored by Azure. */
    content: Record<string, unknown>;
    /** Time the session was created. */
    createdTime: string | undefined;
    /** Time the session was last changed. */
    changedTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A session (`Microsoft.Logic/integrationAccounts/sessions`) in a Logic
 * Apps integration account: a named JSON document that B2B workflows read
 * and write, for example to share state such as control numbers.
 *
 * Sessions carry no tags or metadata, so Alchemy only treats a session it
 * created and persisted as its own; a session found by name without state
 * is reported as unowned and needs `--adopt`.
 *
 * :::caution
 * Changing `name`, `integrationAccount`, or `resourceGroup` replaces the
 * session.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/logic/integration-account-sessions
 *
 * ### Creating a Session
 * **Example:** Session with JSON content
 * ```typescript
 * const account = yield* Azure.Logic.IntegrationAccount("b2b");
 * const session = yield* Azure.Logic.IntegrationAccountSession("orders", {
 *   integrationAccount: account.integrationAccountName,
 *   content: { controlNumber: "1000", partner: "fabrikam" },
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccountSession = GroupedResource<IntegrationAccountSession>(
  "Azure.Logic.IntegrationAccountSession",
);

const getSession = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
  sessionName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccountSession({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
      sessionName,
    }),
  );

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toAttrs = (
  resourceGroup: string,
  integrationAccount: string,
  name: string,
  observed: logic.GetIntegrationAccountSessionResponse,
): IntegrationAccountSession["Attributes"] => ({
  sessionName: name,
  integrationAccount,
  resourceGroup,
  sessionId: observed.id ?? "",
  content: asRecord(observed.properties.content),
  createdTime: observed.properties.createdTime,
  changedTime: observed.properties.changedTime,
});

export const IntegrationAccountSessionProvider = () =>
  Provider.succeed(IntegrationAccountSession, {
    stables: ["sessionName", "integrationAccount", "resourceGroup", "sessionId"],

    // Sessions live inside an integration account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.integrationAccount.toLowerCase() !== output.integrationAccount.toLowerCase() ||
        (news.name !== undefined && news.name.toLowerCase() !== output.sessionName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const integrationAccount = output?.integrationAccount ?? olds?.integrationAccount;
      if (resourceGroup === undefined || integrationAccount === undefined) {
        return undefined;
      }
      const name = output?.sessionName ?? olds?.name ?? (yield* createLogicName(id));
      const observed = yield* getSession(subscriptionId, resourceGroup, integrationAccount, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, integrationAccount, name, observed);
      // No tags or metadata: only a session we persisted is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Logic");
      const { resourceGroup, integrationAccount } = news;
      const name = news.name ?? output?.sessionName ?? (yield* createLogicName(id));

      // Observe.
      let observed = yield* getSession(subscriptionId, resourceGroup, integrationAccount, name);

      // Ensure + sync: the PUT is a synchronous full replacement of the
      // content, which Azure echoes back unchanged.
      const desiredHash = yield* hashOf(news.content);
      const observedHash =
        observed === undefined ? undefined : yield* hashOf(observed.properties.content);
      if (observed === undefined || observedHash !== desiredHash) {
        observed = yield* logic.IntegrationAccountSessionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          integrationAccountName: integrationAccount,
          sessionName: name,
          properties: { content: news.content },
        });
      }

      return toAttrs(resourceGroup, integrationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccountSession({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccount,
          sessionName: output.sessionName,
        }),
      );
      yield* waitUntilGone(
        `integration account session ${output.sessionName}`,
        getSession(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccount,
          output.sessionName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Logic.IntegrationAccount"] },
  });
