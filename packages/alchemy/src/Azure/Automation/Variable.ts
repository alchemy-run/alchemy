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
  reveal,
  sameName,
  sameText,
} from "./Common.ts";

export interface VariableProps {
  /** Resource group of the Automation account. Changing it replaces the variable. */
  resourceGroup: string;
  /** Automation account that holds the variable. Changing it replaces the variable. */
  automationAccount: string;
  /**
   * Variable name (up to 128 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * variable.
   */
  name?: string;
  /**
   * Value of the variable: any JSON-serializable value (a string, number,
   * boolean, object, ...). A `Redacted` value is unwrapped before it is
   * serialized. Omit it for an empty variable.
   */
  value?: unknown;
  /**
   * Encrypt the value at rest. Encrypted values can only be read from
   * runbooks (`Get-AutomationVariable`). Changing it replaces the variable.
   * @default false
   */
  isEncrypted?: boolean;
  /** Description of the variable. */
  description?: string;
}

export interface Variable extends Resource<
  "Azure.Automation.Variable",
  VariableProps,
  {
    /** Name of the variable. */
    variableName: string;
    /** ARM resource ID of the variable. */
    variableId: string;
    /** Automation account that holds the variable. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Whether the value is encrypted. */
    isEncrypted: boolean;
    /** JSON-serialized value (`undefined` when encrypted or empty). */
    value: string | undefined;
    /** Description of the variable. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A variable asset in an Azure Automation account, shared by its runbooks
 * and DSC configurations (`Get-AutomationVariable`).
 *
 * @see https://learn.microsoft.com/azure/automation/shared-resources/variables
 *
 * ### Creating Variables
 * **Example:** Plain variable
 * ```typescript
 * const region = yield* Azure.Automation.Variable("region", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   value: "eastus",
 * });
 * ```
 *
 * **Example:** Encrypted variable
 * ```typescript
 * const apiKey = yield* Azure.Automation.Variable("api-key", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   value: Redacted.make("s3cr3t"),
 *   isEncrypted: true,
 * });
 * ```
 *
 * @resource
 */
export const Variable = Resource<Variable>("Azure.Automation.Variable");

/** Serialize a variable value the way Automation stores it. */
const serialize = (value: unknown) =>
  value === undefined
    ? undefined
    : JSON.stringify(reveal(value));

const getVariable = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  variableName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetVariable({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      variableName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  variable: automation.GetVariableResponse,
): Variable["Attributes"] => ({
  variableName: name,
  variableId: variable.id ?? "",
  automationAccount,
  resourceGroup,
  isEncrypted: variable.properties?.isEncrypted ?? false,
  value: variable.properties?.isEncrypted
    ? undefined
    : variable.properties?.value,
  description: variable.properties?.description,
});

export const VariableProvider = () =>
  Provider.succeed(Variable, {
    stables: ["variableName", "variableId", "automationAccount", "resourceGroup"],

    // Variables live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined && !sameName(news.name, output.variableName)) ||
        (news.isEncrypted ?? false) !== output.isEncrypted
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
        output?.variableName ?? olds?.name ?? (yield* createChildName(id, 128));
      const observed = yield* getVariable(
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
        news.name ?? output?.variableName ?? (yield* createChildName(id, 128));
      const isEncrypted = news.isEncrypted ?? false;
      const value = serialize(news.value);
      const get = getVariable(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Encrypted values cannot be read back; the previous props are the
      // only hint of what was written.
      const valueChanged =
        observed === undefined ||
        (isEncrypted
          ? olds === undefined || serialize(olds.value) !== value
          : (observed.properties?.value ?? undefined) !== value);

      // Ensure + sync: the PUT is a synchronous upsert.
      if (
        observed === undefined ||
        valueChanged ||
        !sameText(observed.properties?.description, news.description)
      ) {
        yield* automation.VariableCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          variableName: name,
          name,
          properties: { value, description: news.description, isEncrypted },
        });
      }

      const fresh = yield* waitForProvisioned(
        `automation variable ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, automationAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        automationAccountName: output.automationAccount,
        variableName: output.variableName,
      };
      yield* ignoreNotFound(automation.DeleteVariable(where));
      yield* waitUntilGone(
        `automation variable ${output.variableName}`,
        getVariable(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.variableName,
        ),
      );
    }),

    nuke: childNuke,
  });
