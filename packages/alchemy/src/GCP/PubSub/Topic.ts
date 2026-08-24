import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type TopicProps = {
  /**
   * Topic id (the `{topic}` segment of `projects/{project}/topics/{topic}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id.
   */
  topicId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Cloud KMS key used to encrypt messages, as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  kmsKeyName?: string;
  /**
   * Minimum duration to retain published messages (e.g. `"86400s"`).
   */
  messageRetentionDuration?: string;
};

export type Topic = Resource<
  "GCP.PubSub.Topic",
  TopicProps,
  {
    /** Full resource name `projects/{project}/topics/{topic}`. */
    name: string;
    /** Topic id (last path segment). */
    topicId: string;
    /** Project id. */
    project: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** KMS key used for encryption, if any. */
    kmsKeyName: string | undefined;
    /** Message retention duration, if set. */
    messageRetentionDuration: string | undefined;
    /** Server-reported topic state. */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Pub/Sub topic.
 *
 * ### Creating a Topic
 * **Example:** Generated name
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {});
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {
 *   topicId: "order-events",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category PubSub
 */
export const Topic = Resource<Topic>("GCP.PubSub.Topic");

export class TopicNotResolved extends Data.TaggedError(
  "GCP.PubSub.TopicNotResolved",
)<{
  name: string;
}> {}

const topicIdOf = (name: string) => name.split("/").pop() ?? name;

const resourceName = (project: string, topicId: string) =>
  `projects/${project}/topics/${topicId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, topicId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      topicId ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: 255, lowercase: true }))
    );
  });

const toAttrs = (topic: pubsub.Topic, project: string) => {
  const name = topic.name ?? "";
  return {
    name,
    topicId: topicIdOf(name),
    project,
    labels: userLabels(topic.labels),
    kmsKeyName: topic.kmsKeyName,
    messageRetentionDuration: topic.messageRetentionDuration,
    state: topic.state,
  };
};

const getByName = (name: string) =>
  pubsub
    .getProjectsTopics({ topic: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    stables: ["name", "topicId", "project"],

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const topicId = yield* toId(id, olds?.topicId, output?.topicId);
      const name = output?.name ?? resourceName(env.project, topicId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const page = yield* pubsub.listProjectsTopics({
          project: `projects/${env.project}`,
          pageSize: 1000,
        });
        return (page.topics ?? [])
          .filter((topic) =>
            Object.keys(topic.labels ?? {}).some((key) =>
              key.startsWith("alchemy-"),
            ),
          )
          .map((topic) => toAttrs(topic, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const topicId = yield* toId(id, news.topicId, output?.topicId);
      const name = resourceName(env.project, topicId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* pubsub
          .createProjectsTopics({
            name,
            body: {
              labels: desiredLabels,
              kmsKeyName: news.kmsKeyName,
              messageRetentionDuration: news.messageRetentionDuration,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TopicNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const kmsChanged = (current.kmsKeyName ?? "") !== (news.kmsKeyName ?? "");
      const retentionChanged =
        (current.messageRetentionDuration ?? "") !==
        (news.messageRetentionDuration ?? "");

      if (labelsChanged || kmsChanged || retentionChanged) {
        current = yield* pubsub.patchProjectsTopics({
          name,
          body: {
            topic: {
              name,
              labels: desiredLabels,
              kmsKeyName: news.kmsKeyName,
              messageRetentionDuration: news.messageRetentionDuration,
            },
            updateMask: [
              labelsChanged ? "labels" : undefined,
              kmsChanged ? "kmsKeyName" : undefined,
              retentionChanged ? "messageRetentionDuration" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* pubsub
        .deleteProjectsTopics({ topic: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
