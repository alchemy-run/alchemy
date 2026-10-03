import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  CHILD_BUDGET,
  sameArm,
  sameValue,
  whileAccountBusy,
} from "./Common.ts";

export interface RaiToolLabelProjectScope {
  /** Project the labels apply to. */
  project: string;
  /** Built-in label values for the project, e.g. `{ DataConfidentiality: "Confidential" }`. */
  labelValues: Record<string, string>;
}

export interface RaiToolLabelProps {
  /** Resource group of the account. Changing it replaces the label. */
  resourceGroup: string;
  /** Account that holds the label. Changing it replaces the label. */
  account: string;
  /**
   * Name of the tool connection the labels describe (e.g. `Web_Search`).
   * It is also the resource name. Changing it replaces the label.
   */
  toolConnectionName: string;
  /**
   * Built-in label values for the whole account. Supported labels:
   * `DataDirection`, `DataConfidentiality` (`Confidential`,
   * `Non-confidential`), `DataIntegrity`, `ActionConsequentiality`,
   * `ThirdPartyInteraction`, `ToolType`.
   */
  accountLabels?: Record<string, string>;
  /** Per-project label values. */
  projectScopes?: RaiToolLabelProjectScope[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface RaiToolLabel extends Resource<
  "Azure.CognitiveServices.RaiToolLabel",
  RaiToolLabelProps,
  {
    /** Name of the tool connection (and of the label resource). */
    toolConnectionName: string;
    /** ARM resource ID of the label. */
    raiToolLabelId: string;
    /** Account that holds the label. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Account-scope label values (Azure camel-cases the label names). */
    accountLabels: Record<string, string>;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Responsible AI labels for an agent tool connection
 * (`Microsoft.CognitiveServices/accounts/raiToolLabels`, preview). Labels
 * such as `DataConfidentiality` tell the guardrails how to treat data the
 * tool sends and receives, for the whole account or per project.
 *
 * ### Labeling a Tool
 * **Example:** Mark a web-search tool as handling non-confidential data
 * ```typescript
 * yield* Azure.CognitiveServices.RaiToolLabel("web-search", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   toolConnectionName: "Web_Search",
 *   accountLabels: { DataConfidentiality: "Non-confidential" },
 * });
 * ```
 *
 * @resource
 */
export const RaiToolLabel = Resource<RaiToolLabel>(
  "Azure.CognitiveServices.RaiToolLabel",
);

const getLabel = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  raiToolConnectionName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetRaiToolLabel({
      subscriptionId,
      resourceGroupName,
      accountName,
      raiToolConnectionName,
    }),
  );

const clean = (map: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/** Azure camel-cases label names (`DataConfidentiality` → `dataConfidentiality`). */
const labelKey = (map: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(clean(map)).map(([k, v]) => [k.toLowerCase(), v]),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  label: cognitiveservices.GetRaiToolLabelResponse,
): RaiToolLabel["Attributes"] => ({
  toolConnectionName: name,
  raiToolLabelId: label.id ?? "",
  account,
  resourceGroup,
  accountLabels: clean(label.properties?.accountScope?.labelValues),
  tags: userTags(label.tags),
});

const scopesOf = (
  scopes: ReadonlyArray<{
    readonly project: string;
    readonly labelValues: Record<string, string | undefined>;
  }>,
) =>
  [...scopes]
    .map((scope) => ({
      project: scope.project.toLowerCase(),
      labelValues: labelKey(scope.labelValues),
    }))
    .sort((a, b) => a.project.localeCompare(b.project));

export const RaiToolLabelProvider = () =>
  Provider.succeed(RaiToolLabel, {
    stables: [
      "toolConnectionName",
      "raiToolLabelId",
      "account",
      "resourceGroup",
    ],

    // Labels live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        !sameArm(news.toolConnectionName, output.toolConnectionName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const name = output?.toolConnectionName ?? olds?.toolConnectionName;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getLabel(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account, toolConnectionName: name } = news;
      const tags = yield* desiredTags(id, news.tags);
      const properties: cognitiveservices.RaiToolLabelProperties = {
        toolConnectionName: name,
        accountScope:
          news.accountLabels === undefined
            ? undefined
            : { labelValues: news.accountLabels },
        projectScopes: news.projectScopes,
      };
      const get = getLabel(subscriptionId, resourceGroup, account, name);

      // Observe; the PUT is a synchronous upsert sent only on a delta.
      const observed = yield* get;
      const props = observed?.properties;
      if (
        observed === undefined ||
        (news.accountLabels !== undefined &&
          !sameValue(
            labelKey(props?.accountScope?.labelValues),
            labelKey(news.accountLabels),
          )) ||
        (news.projectScopes !== undefined &&
          !sameValue(
            scopesOf(props?.projectScopes ?? []),
            scopesOf(news.projectScopes),
          )) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* cognitiveservices
          .RaiToolLabelsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            raiToolConnectionName: name,
            properties,
            tags,
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `rai tool label ${name}`,
        get,
        () => undefined,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteRaiToolLabel({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            raiToolConnectionName: output.toolConnectionName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `rai tool label ${output.toolConnectionName}`,
        getLabel(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.toolConnectionName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
