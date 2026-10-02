import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
import {
  accountOwnedByStage,
  childNuke,
  createChildName,
  reveal,
  sameName,
  sameText,
} from "./Common.ts";

export interface ConnectionProps {
  /** Resource group of the Automation account. Changing it replaces the connection. */
  resourceGroup: string;
  /** Automation account that holds the connection. Changing it replaces the connection. */
  automationAccount: string;
  /**
   * Connection name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * Connection type: a built-in type (`Azure`, `AzureServicePrincipal`,
   * `AzureClassicCertificate`) or a custom {@link ConnectionType}. Changing
   * it replaces the connection.
   */
  connectionType: string;
  /**
   * Field values keyed by field name. Encrypted fields are write-only, so
   * changes to them are detected against the previously deployed values.
   */
  fieldDefinitionValues?: Record<string, string | Redacted.Redacted<string>>;
  /** Description of the connection. */
  description?: string;
}

export interface Connection extends Resource<
  "Azure.Automation.Connection",
  ConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Automation account that holds the connection. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Connection type name. */
    connectionType: string;
    /** Description of the connection. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A connection asset in an Azure Automation account: the values needed to
 * reach an external system, shaped by a connection type and read by
 * runbooks with `Get-AutomationConnection`.
 *
 * @see https://learn.microsoft.com/azure/automation/automation-connections
 *
 * ### Creating a Connection
 * **Example:** Connection of a custom type
 * ```typescript
 * const apiType = yield* Azure.Automation.ConnectionType("api", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   fieldDefinitions: { Endpoint: { type: "System.String" } },
 * });
 * const api = yield* Azure.Automation.Connection("api", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   connectionType: apiType.connectionTypeName,
 *   fieldDefinitionValues: { Endpoint: "https://api.example.com" },
 * });
 * ```
 *
 * @resource
 */
export const Connection = Resource<Connection>("Azure.Automation.Connection");

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  connectionName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetConnection({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      connectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  connection: automation.GetConnectionResponse,
): Connection["Attributes"] => ({
  connectionName: name,
  connectionId: connection.id ?? "",
  automationAccount,
  resourceGroup,
  connectionType: connection.properties?.connectionType?.name ?? "",
  description: connection.properties?.description,
});

const plainValues = (
  values: ConnectionProps["fieldDefinitionValues"],
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([k, v]) => [k, reveal(v) as string]),
  );

const sameValues = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: [
      "connectionName",
      "connectionId",
      "automationAccount",
      "resourceGroup",
    ],

    // Connections live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined &&
          !sameName(news.name, output.connectionName)) ||
        !sameName(news.connectionType, output.connectionType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.connectionName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* accountOwnedByStage(subscriptionId, resourceGroup, account))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ?? output?.connectionName ?? (yield* createChildName(id));
      const values = plainValues(news.fieldDefinitionValues);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        connectionName: name,
      };
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* automation.ConnectionCreateOrUpdate({
          ...where,
          name,
          properties: {
            connectionType: { name: news.connectionType },
            fieldDefinitionValues: values,
            description: news.description,
          },
        });
        observed = yield* waitForProvisioned(
          `automation connection ${name}`,
          get,
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      } else {
        // Sync. Encrypted values are not returned, so compare the observed
        // plain values and fall back to the previous props for the rest.
        const observedValues = Object.fromEntries(
          Object.entries(observed.properties?.fieldDefinitionValues ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const visible = Object.fromEntries(
          Object.entries(values).filter(([k]) => k in observedValues),
        );
        const valuesChanged =
          !sameValues(visible, observedValues) ||
          olds === undefined ||
          !sameValues(values, plainValues(olds.fieldDefinitionValues));
        const descriptionChanged = !sameText(
          observed.properties?.description,
          news.description,
        );
        if (valuesChanged || descriptionChanged) {
          observed = yield* automation.UpdateConnection({
            ...where,
            name,
            properties: {
              description: news.description ?? "",
              fieldDefinitionValues: valuesChanged ? values : undefined,
            },
          });
        }
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          connectionName: output.connectionName,
        }),
      );
      yield* waitUntilGone(
        `automation connection ${output.connectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.connectionName,
        ),
      );
    }),

    nuke: childNuke,
  });
