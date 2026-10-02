import * as automation from "@distilled.cloud/azure/automation";
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
import {
  accountOwnedByStage,
  childNuke,
  createChildName,
  sameName,
} from "./Common.ts";

export interface ConnectionTypeField {
  /** Field type, e.g. `System.String`. */
  type: string;
  /** Whether the field value is encrypted. @default false */
  isEncrypted?: boolean;
  /** Whether the field may be left empty. @default false */
  isOptional?: boolean;
}

export interface ConnectionTypeProps {
  /** Resource group of the Automation account. Changing it replaces the connection type. */
  resourceGroup: string;
  /** Automation account that holds the connection type. Changing it replaces the connection type. */
  automationAccount: string;
  /**
   * Connection type name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the connection type.
   */
  name?: string;
  /**
   * Fields every connection of this type carries, keyed by field name.
   * Connection types cannot be updated: changing a field replaces the type.
   */
  fieldDefinitions: Record<string, ConnectionTypeField>;
  /**
   * Whether the connection type is global. Changing it replaces the
   * connection type.
   * @default false
   */
  isGlobal?: boolean;
}

export interface ConnectionType extends Resource<
  "Azure.Automation.ConnectionType",
  ConnectionTypeProps,
  {
    /** Name of the connection type. */
    connectionTypeName: string;
    /** ARM resource ID of the connection type. */
    connectionTypeId: string;
    /** Automation account that holds the connection type. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Field names defined by the type. */
    fieldNames: string[];
    /** Creation time. */
    creationTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom connection type in an Azure Automation account: the schema
 * (field names and types) of {@link Connection} assets.
 *
 * Connection types are immutable; any change replaces them.
 *
 * @see https://learn.microsoft.com/azure/automation/automation-connections
 *
 * ### Defining a Connection Type
 * **Example:** API endpoint with a secret key
 * ```typescript
 * const apiType = yield* Azure.Automation.ConnectionType("api", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   fieldDefinitions: {
 *     Endpoint: { type: "System.String" },
 *     Key: { type: "System.String", isEncrypted: true },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ConnectionType = Resource<ConnectionType>(
  "Azure.Automation.ConnectionType",
);

const getConnectionType = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  connectionTypeName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetConnectionType({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      connectionTypeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  type: automation.GetConnectionTypeResponse,
): ConnectionType["Attributes"] => ({
  connectionTypeName: name,
  connectionTypeId: type.id ?? "",
  automationAccount,
  resourceGroup,
  fieldNames: Object.keys(type.properties?.fieldDefinitions ?? {}).sort(),
  creationTime: type.properties?.creationTime,
});

const normalize = (fields: Record<string, ConnectionTypeField>) =>
  JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((key) => [
        key,
        fields[key]!.type,
        fields[key]!.isEncrypted ?? false,
        fields[key]!.isOptional ?? false,
      ]),
  );

export const ConnectionTypeProvider = () =>
  Provider.succeed(ConnectionType, {
    stables: [
      "connectionTypeName",
      "connectionTypeId",
      "automationAccount",
      "resourceGroup",
    ],

    // Connection types live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined &&
          !sameName(news.name, output.connectionTypeName)) ||
        (olds !== undefined &&
          (normalize(news.fieldDefinitions) !==
            normalize(olds.fieldDefinitions) ||
            (news.isGlobal ?? false) !== (olds.isGlobal ?? false)))
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
        output?.connectionTypeName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getConnectionType(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* accountOwnedByStage(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    // Existence-only: there is no update API (a PUT on an existing type
    // returns 409), so every change is a replacement.
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ?? output?.connectionTypeName ?? (yield* createChildName(id));
      const get = getConnectionType(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe → ensure.
      if ((yield* get) === undefined) {
        yield* automation.ConnectionTypeCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          connectionTypeName: name,
          name,
          properties: {
            isGlobal: news.isGlobal ?? false,
            fieldDefinitions: news.fieldDefinitions,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `automation connection type ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, automationAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteConnectionType({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          connectionTypeName: output.connectionTypeName,
        }),
      );
      yield* waitUntilGone(
        `automation connection type ${output.connectionTypeName}`,
        getConnectionType(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.connectionTypeName,
        ),
      );
    }),

    nuke: childNuke,
  });
