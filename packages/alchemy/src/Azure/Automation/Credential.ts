import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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

export interface CredentialProps {
  /** Resource group of the Automation account. Changing it replaces the credential. */
  resourceGroup: string;
  /** Automation account that holds the credential. Changing it replaces the credential. */
  automationAccount: string;
  /**
   * Credential name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the credential.
   */
  name?: string;
  /** User name of the credential. */
  userName: string;
  /**
   * Password of the credential. Write-only: Azure never returns it, so a
   * change is detected against the previously deployed value.
   */
  password: Redacted.Redacted<string>;
  /** Description of the credential. */
  description?: string;
}

export interface Credential extends Resource<
  "Azure.Automation.Credential",
  CredentialProps,
  {
    /** Name of the credential. */
    credentialName: string;
    /** ARM resource ID of the credential. */
    credentialId: string;
    /** Automation account that holds the credential. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** User name of the credential. */
    userName: string | undefined;
    /** Description of the credential. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A credential asset (user name + password) in an Azure Automation account,
 * read by runbooks with `Get-AutomationPSCredential`.
 *
 * @see https://learn.microsoft.com/azure/automation/shared-resources/credentials
 *
 * ### Creating a Credential
 * **Example:** Service login
 * ```typescript
 * const login = yield* Azure.Automation.Credential("sql-login", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   userName: "ops",
 *   password: Redacted.make(process.env.SQL_PASSWORD!),
 * });
 * ```
 *
 * @resource
 */
export const Credential = Resource<Credential>("Azure.Automation.Credential");

const getCredential = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  credentialName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetCredential({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      credentialName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  credential: automation.GetCredentialResponse,
): Credential["Attributes"] => ({
  credentialName: name,
  credentialId: credential.id ?? "",
  automationAccount,
  resourceGroup,
  userName: credential.properties?.userName,
  description: credential.properties?.description,
});

export const CredentialProvider = () =>
  Provider.succeed(Credential, {
    stables: [
      "credentialName",
      "credentialId",
      "automationAccount",
      "resourceGroup",
    ],

    // Credentials live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined && !sameName(news.name, output.credentialName))
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
        output?.credentialName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getCredential(
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

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ?? output?.credentialName ?? (yield* createChildName(id));
      const get = getCredential(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      const observed = yield* get;

      // The password cannot be read back; the previous props are the only
      // hint of what was written.
      const passwordChanged =
        olds === undefined || reveal(olds.password) !== reveal(news.password);

      // Ensure + sync: the PUT is a synchronous upsert.
      if (
        observed === undefined ||
        passwordChanged ||
        observed.properties?.userName !== news.userName ||
        !sameText(observed.properties?.description, news.description)
      ) {
        yield* automation.CredentialCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          credentialName: name,
          name,
          properties: {
            userName: news.userName,
            password: news.password,
            description: news.description,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `automation credential ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, automationAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteCredential({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          credentialName: output.credentialName,
        }),
      );
      yield* waitUntilGone(
        `automation credential ${output.credentialName}`,
        getCredential(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.credentialName,
        ),
      );
    }),

    nuke: childNuke,
  });
