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
  createChildName,
  sameArm,
  whileAccountBusy,
} from "./Common.ts";

export interface RaiTopicProps {
  /** Resource group of the account. Changing it replaces the topic. */
  resourceGroup: string;
  /** Account that holds the topic. Changing it replaces the topic. */
  account: string;
  /**
   * Topic resource name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the topic.
   */
  name?: string;
  /**
   * Display name of the topic.
   * @default the resource name
   */
  topicName?: string;
  /** What the topic covers; used to detect it. */
  description: string;
  /**
   * URL (typically a SAS URL) of a `.jsonl` blob with sample texts that
   * belong to the topic.
   */
  sampleBlobUrl: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface RaiTopic extends Resource<
  "Azure.CognitiveServices.RaiTopic",
  RaiTopicProps,
  {
    /** Resource name of the topic. */
    raiTopicName: string;
    /** ARM resource ID of the topic. */
    raiTopicId: string;
    /** Account that holds the topic. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Service-assigned topic ID. */
    topicId: string | undefined;
    /** Training status of the topic. */
    status: string | undefined;
    /** Why training failed, if it did. */
    failedReason: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A custom content-safety topic (`Microsoft.CognitiveServices/accounts/raiTopics`,
 * preview): a description plus sample texts that teach the guardrails to
 * detect a topic, e.g. to block questions about competitors.
 *
 * Azure trains the topic asynchronously after creation; `status` reports
 * progress.
 *
 * @see https://learn.microsoft.com/azure/ai-services/content-safety/concepts/custom-categories
 *
 * ### Creating a Topic
 * **Example:** Topic trained from a JSONL sample blob
 * ```typescript
 * const topic = yield* Azure.CognitiveServices.RaiTopic("competitors", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   description: "Questions comparing our product with competitors",
 *   sampleBlobUrl: "https://samples.blob.core.windows.net/topics/competitors.jsonl?sv=...",
 * });
 * ```
 *
 * @resource
 */
export const RaiTopic = Resource<RaiTopic>("Azure.CognitiveServices.RaiTopic");

const getTopic = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  raiTopicName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetRaiTopic({
      subscriptionId,
      resourceGroupName,
      accountName,
      raiTopicName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  topic: cognitiveservices.GetRaiTopicResponse,
): RaiTopic["Attributes"] => ({
  raiTopicName: name,
  raiTopicId: topic.id ?? "",
  account,
  resourceGroup,
  topicId: topic.properties?.topicId,
  status: topic.properties?.status,
  failedReason: topic.properties?.failedReason,
  tags: userTags(topic.tags),
});

export const RaiTopicProvider = () =>
  Provider.succeed(RaiTopic, {
    stables: ["raiTopicName", "raiTopicId", "account", "resourceGroup"],

    // Topics live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        (news.name !== undefined && !sameArm(news.name, output.raiTopicName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.raiTopicName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getTopic(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.raiTopicName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const topicName = news.topicName ?? name;
      const get = getTopic(subscriptionId, resourceGroup, account, name);

      // Observe; the PUT is a synchronous upsert sent only on a delta.
      const observed = yield* get;
      const props = observed?.properties;
      if (
        observed === undefined ||
        props?.topicName !== topicName ||
        props?.description !== news.description ||
        props?.sampleBlobUrl !== news.sampleBlobUrl ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* cognitiveservices
          .RaiTopicsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            raiTopicName: name,
            properties: {
              topicName,
              description: news.description,
              sampleBlobUrl: news.sampleBlobUrl,
            },
            tags,
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `rai topic ${name}`,
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
          .DeleteRaiTopic({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            raiTopicName: output.raiTopicName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `rai topic ${output.raiTopicName}`,
        getTopic(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.raiTopicName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
