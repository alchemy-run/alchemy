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

export type SourceControlType = "GitHub" | "VsoGit" | "VsoTfvc";

export interface SourceControlSecurityToken {
  /** Personal access token or OAuth access token for the repository. */
  accessToken: Redacted.Redacted<string>;
  /** OAuth refresh token. */
  refreshToken?: Redacted.Redacted<string>;
  /** Kind of token. @default "PersonalAccessToken" */
  tokenType?: "PersonalAccessToken" | "Oauth";
}

export interface SourceControlProps {
  /** Resource group of the Automation account. Changing it replaces the source control. */
  resourceGroup: string;
  /** Automation account that holds the source control. Changing it replaces the source control. */
  automationAccount: string;
  /**
   * Source control name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the source control.
   */
  name?: string;
  /** Repository URL. Changing it replaces the source control. */
  repoUrl: string;
  /** Repository host. Changing it replaces the source control. */
  sourceType: SourceControlType;
  /** Branch to sync (Git repositories). */
  branch?: string;
  /** Folder of the repository that holds the runbooks. @default "/" */
  folderPath?: string;
  /**
   * Sync on every commit. Requires the account's system-assigned identity
   * to have Contributor access on the account.
   * @default false
   */
  autoSync?: boolean;
  /** Publish runbooks after syncing them. @default true */
  publishRunbook?: boolean;
  /**
   * Token the account uses to read the repository. Write-only: changes are
   * detected against the previously deployed token.
   */
  securityToken: SourceControlSecurityToken;
  /** Description of the source control. */
  description?: string;
}

export interface SourceControl extends Resource<
  "Azure.Automation.SourceControl",
  SourceControlProps,
  {
    /** Name of the source control. */
    sourceControlName: string;
    /** ARM resource ID of the source control. */
    sourceControlId: string;
    /** Automation account that holds the source control. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Repository URL. */
    repoUrl: string;
    /** Repository host. */
    sourceType: string;
    /** Synced branch. */
    branch: string | undefined;
    /** Synced folder. */
    folderPath: string | undefined;
    /** Whether every commit syncs. */
    autoSync: boolean;
    /** Whether synced runbooks are published. */
    publishRunbook: boolean;
  },
  never,
  Providers
> {}

/**
 * Connects an Azure Automation account to a GitHub or Azure DevOps
 * repository so runbooks are synced from source control.
 *
 * @see https://learn.microsoft.com/azure/automation/source-control-integration
 *
 * ### Syncing Runbooks from GitHub
 * **Example:** GitHub repository with a personal access token
 * ```typescript
 * yield* Azure.Automation.SourceControl("runbooks", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   repoUrl: "https://github.com/acme/runbooks.git",
 *   sourceType: "GitHub",
 *   branch: "main",
 *   folderPath: "/runbooks",
 *   securityToken: { accessToken: Redacted.make(process.env.GITHUB_PAT!) },
 * });
 * ```
 *
 * @resource
 */
export const SourceControl = Resource<SourceControl>(
  "Azure.Automation.SourceControl",
);

const getSourceControl = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  sourceControlName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetSourceControl({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      sourceControlName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  source: automation.GetSourceControlResponse,
): SourceControl["Attributes"] => ({
  sourceControlName: name,
  sourceControlId: source.id ?? "",
  automationAccount,
  resourceGroup,
  repoUrl: source.properties?.repoUrl ?? "",
  sourceType: source.properties?.sourceType ?? "",
  branch: source.properties?.branch,
  folderPath: source.properties?.folderPath,
  autoSync: source.properties?.autoSync ?? false,
  publishRunbook: source.properties?.publishRunbook ?? false,
});

const toToken = (token: SourceControlSecurityToken) => ({
  accessToken: reveal(token.accessToken) as string,
  refreshToken:
    token.refreshToken === undefined
      ? undefined
      : (reveal(token.refreshToken) as string),
  tokenType: token.tokenType ?? "PersonalAccessToken",
});

const sameToken = (
  a: SourceControlSecurityToken | undefined,
  b: SourceControlSecurityToken,
) =>
  a !== undefined && JSON.stringify(toToken(a)) === JSON.stringify(toToken(b));

export const SourceControlProvider = () =>
  Provider.succeed(SourceControl, {
    stables: [
      "sourceControlName",
      "sourceControlId",
      "automationAccount",
      "resourceGroup",
      "repoUrl",
      "sourceType",
    ],

    // Source controls live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined &&
          !sameName(news.name, output.sourceControlName)) ||
        !sameName(news.repoUrl, output.repoUrl) ||
        !sameName(news.sourceType, output.sourceType)
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
        output?.sourceControlName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getSourceControl(
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
        news.name ?? output?.sourceControlName ?? (yield* createChildName(id));
      const desired = {
        branch: news.branch,
        folderPath: news.folderPath ?? "/",
        autoSync: news.autoSync ?? false,
        publishRunbook: news.publishRunbook ?? true,
        description: news.description,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        sourceControlName: name,
      };
      const get = getSourceControl(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* automation.SourceControlCreateOrUpdate({
          ...where,
          properties: {
            repoUrl: news.repoUrl,
            sourceType: news.sourceType,
            securityToken: toToken(news.securityToken),
            ...desired,
          },
        });
        observed = yield* waitForProvisioned(
          `source control ${name}`,
          get,
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      } else {
        // Sync the mutable aspects against observed; the token is
        // write-only, so compare it against the previous props.
        const props = observed.properties;
        const tokenChanged = !sameToken(
          olds?.securityToken,
          news.securityToken,
        );
        if (
          tokenChanged ||
          (desired.branch !== undefined && props?.branch !== desired.branch) ||
          props?.folderPath !== desired.folderPath ||
          (props?.autoSync ?? false) !== desired.autoSync ||
          (props?.publishRunbook ?? false) !== desired.publishRunbook ||
          !sameText(props?.description, desired.description)
        ) {
          observed = yield* automation.UpdateSourceControl({
            ...where,
            properties: {
              ...desired,
              description: desired.description ?? "",
              securityToken: tokenChanged
                ? toToken(news.securityToken)
                : undefined,
            },
          });
        }
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteSourceControl({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          sourceControlName: output.sourceControlName,
        }),
      );
      yield* waitUntilGone(
        `source control ${output.sourceControlName}`,
        getSourceControl(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.sourceControlName,
        ),
      );
    }),

    nuke: childNuke,
  });
