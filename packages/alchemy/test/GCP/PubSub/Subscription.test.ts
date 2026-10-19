import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import { projectNumber } from "@/GCP/Host";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (name: string) =>
  pubsub.getProjectsSubscriptions({ subscription: name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const getSubscription = (name: string) =>
  pubsub.getProjectsSubscriptions({ subscription: name }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const pullUntilMessage = (name: string) =>
  pubsub
    .pullProjectsSubscriptions({
      subscription: name,
      body: { maxMessages: 1, returnImmediately: true },
    })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (response) => (response.receivedMessages?.length ?? 0) > 0,
        times: 10,
      }),
    );

test.provider(
  "create, update, and delete a subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            labels: { env: "test" },
          });
          const subscription = yield* GCP.PubSub.Subscription("Orders", {
            topic: topic.name,
            labels: { env: "test" },
          });
          return { topic, subscription };
        }),
      );

      expect(created.subscription.name).toContain("/subscriptions/");
      expect(created.subscription.subscriptionId).toEqual(expect.any(String));
      expect(created.subscription.topic).toEqual(created.topic.name);
      expect(created.subscription.labels).toMatchObject({ env: "test" });
      expect(created.subscription.ackDeadlineSeconds).toEqual(10);

      const fetched = yield* getSubscription(created.subscription.name);
      expect(fetched.name).toEqual(created.subscription.name);
      expect(fetched.topic).toEqual(created.topic.name);
      expect(fetched.labels?.env).toEqual("test");

      yield* pubsub.publishProjectsTopics({
        topic: created.topic.name,
        body: { messages: [{ data: btoa("hello-pubsub") }] },
      });

      const pulled = yield* pullUntilMessage(created.subscription.name);
      const received = pulled.receivedMessages ?? [];
      expect(received.length).toBeGreaterThan(0);
      const ackId = received[0]?.ackId;
      expect(ackId).toEqual(expect.any(String));
      if (ackId !== undefined) {
        yield* pubsub.acknowledgeProjectsSubscriptions({
          subscription: created.subscription.name,
          body: { ackIds: [ackId] },
        });
      }

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            topicId: created.topic.topicId,
            labels: { env: "test" },
          });
          const subscription = yield* GCP.PubSub.Subscription("Orders", {
            subscriptionId: created.subscription.subscriptionId,
            topic: topic.name,
            labels: { env: "prod", role: "orders" },
            ackDeadlineSeconds: 30,
            messageRetentionDuration: "86400s",
          });
          return { topic, subscription };
        }),
      );

      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.topic).toEqual(created.topic.name);
      expect(updated.subscription.labels).toMatchObject({
        env: "prod",
        role: "orders",
      });
      expect(updated.subscription.ackDeadlineSeconds).toEqual(30);
      expect(updated.subscription.messageRetentionDuration).toEqual("86400s");

      const fetchedUpdated = yield* getSubscription(updated.subscription.name);
      expect(fetchedUpdated.ackDeadlineSeconds).toEqual(30);
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("orders");
      expect(fetchedUpdated.messageRetentionDuration).toEqual("86400s");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.subscription.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 90_000 },
);

test.provider(
  "dead-letters a message after maxDeliveryAttempts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("DlqSource", {});
          const deadLetters = yield* GCP.PubSub.Topic("DlqTarget", {});
          const inbox = yield* GCP.PubSub.Subscription("DlqInbox", {
            topic: deadLetters.name,
          });
          const subscription = yield* GCP.PubSub.Subscription("DlqWork", {
            topic: topic.name,
            deadLetterPolicy: {
              deadLetterTopic: deadLetters.name,
              maxDeliveryAttempts: 5,
            },
          });
          return {
            topic: topic.name,
            deadLetters: deadLetters.name,
            inbox: inbox.name,
            subscription: subscription.name,
          };
        }),
      );

      // The Pub/Sub service agent forwards dead letters, so it must be
      // able to publish to the target and ack on the source subscription.
      const topicPolicy = yield* pubsub.getIamPolicyProjectsTopics({
        resource: out.deadLetters,
      });
      const agent = (topicPolicy.bindings ?? [])
        .find((binding) => binding.role === "roles/pubsub.publisher")
        ?.members?.find((member) => member.includes("@gcp-sa-pubsub."));
      expect(agent).toBeDefined();
      const subscriptionPolicy = yield* pubsub.getIamPolicyProjectsSubscriptions({
        resource: out.subscription,
      });
      expect(
        (subscriptionPolicy.bindings ?? []).some(
          (binding) =>
            binding.role === "roles/pubsub.subscriber" && binding.members?.includes(agent!),
        ),
      ).toBe(true);

      yield* pubsub.publishProjectsTopics({
        topic: out.topic,
        body: { messages: [{ data: btoa("poison") }] },
      });

      // Pull and nack until Pub/Sub gives up on the message.
      const nackOnce = pubsub
        .pullProjectsSubscriptions({
          subscription: out.subscription,
          body: { maxMessages: 1, returnImmediately: true },
        })
        .pipe(
          Effect.tap(({ receivedMessages = [] }) => {
            const ackIds = receivedMessages.flatMap((m) => (m.ackId ? [m.ackId] : []));
            return ackIds.length === 0
              ? Effect.void
              : pubsub.modifyAckDeadlineProjectsSubscriptions({
                  subscription: out.subscription,
                  body: { ackIds, ackDeadlineSeconds: 0 },
                });
          }),
        );
      const deadLetter = pubsub
        .pullProjectsSubscriptions({
          subscription: out.inbox,
          body: { maxMessages: 1, returnImmediately: true },
        })
        .pipe(Effect.map(({ receivedMessages = [] }) => receivedMessages[0]));

      const letter = yield* nackOnce.pipe(
        Effect.andThen(deadLetter),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (message) => message !== undefined,
          times: 60,
        }),
      );
      expect(atob(letter!.message?.data ?? "")).toEqual("poison");
      expect(letter!.message?.attributes?.CloudPubSubDeadLetterSourceSubscription).toEqual(
        out.subscription.split("/").pop(),
      );

      yield* stack.destroy();
      expect(yield* waitUntilGone(out.subscription)).toEqual("gone");
      expect(yield* waitUntilGone(out.inbox)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 240_000 },
);

test.provider(
  "writes messages to a BigQuery table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Pub/Sub writes to BigQuery as the project's Pub/Sub service agent.
      const { project } = yield* GcpEnvironment.current;
      const agent = `serviceAccount:service-${yield* projectNumber(project)}@gcp-sa-pubsub.iam.gserviceaccount.com`;

      const writerStack = Effect.gen(function* () {
        const topic = yield* GCP.PubSub.Topic("Impressions", {});
        const dataset = yield* GCP.BigQuery.Dataset("ImpressionsRaw", {
          location: "US-CENTRAL1",
          forceDestroy: true,
        });
        const table = yield* GCP.BigQuery.Table("ImpressionEvent", {
          datasetId: dataset.datasetId,
          schema: [
            { name: "subscription_name", type: "STRING" },
            { name: "message_id", type: "STRING" },
            { name: "publish_time", type: "TIMESTAMP" },
            { name: "data", type: "STRING" },
            { name: "attributes", type: "STRING" },
          ],
        });
        const writer = yield* GCP.IAM.Member("ImpressionsWriter", {
          kind: "bigquery.table",
          name: table.name,
          role: "roles/bigquery.dataEditor",
          member: agent,
        });
        return { topic, table, writer };
      });

      const bigqueryStack = (writeMetadata: boolean) =>
        Effect.gen(function* () {
          const { topic, table, writer } = yield* writerStack;
          const subscription = yield* GCP.PubSub.Subscription("ImpressionsBigQuery", {
            topic: topic.name,
            bigqueryConfig: {
              // Reading the grant orders the subscription after it: Pub/Sub
              // checks the service agent's table access at create time.
              table: Output.map(writer.name, (name) => {
                const [, projectId, , datasetId, , tableId] = name.split("/");
                return `${projectId}.${datasetId}.${tableId}`;
              }),
              writeMetadata,
            },
          });
          return { topic, table, subscription };
        });

      // A fresh table grant can take up to a minute to reach Pub/Sub, which
      // checks the writer's access when it creates the subscription.
      yield* stack.deploy(writerStack);
      yield* Effect.sleep("60 seconds");

      const created = yield* stack.deploy(bigqueryStack(true));
      const tableRef = `${created.table.project}.${created.table.datasetId}.${created.table.tableId}`;
      expect(created.subscription.bigqueryConfig).toEqual({
        table: tableRef,
        useTopicSchema: false,
        useTableSchema: false,
        writeMetadata: true,
        dropUnknownFields: false,
      });

      const fetched = yield* getSubscription(created.subscription.name);
      expect(fetched.bigqueryConfig?.table).toEqual(tableRef);
      expect(fetched.bigqueryConfig?.writeMetadata).toBe(true);

      const published = yield* pubsub.publishProjectsTopics({
        topic: created.topic.name,
        body: { messages: [{ data: btoa("impression-1") }] },
      });
      const messageId = published.messageIds?.[0];
      expect(messageId).toEqual(expect.any(String));

      const rows = yield* bigquery
        .queryJobs({
          projectId: created.table.project,
          body: {
            query: `SELECT DISTINCT data, message_id FROM ${created.table.datasetId}.${created.table.tableId}`,
            useLegacySql: false,
            location: created.table.location,
          },
        })
        .pipe(
          Effect.map(({ rows = [] }) => rows.map((row) => row.f?.map((cell) => cell.v))),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (rows) => rows.length > 0,
            times: 30,
          }),
        );
      expect(rows).toEqual([["impression-1", messageId]]);

      const updated = yield* stack.deploy(bigqueryStack(false));
      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.bigqueryConfig).toMatchObject({
        table: tableRef,
        writeMetadata: false,
      });

      const fetchedUpdated = yield* getSubscription(updated.subscription.name);
      expect(fetchedUpdated.bigqueryConfig?.table).toEqual(tableRef);
      expect(fetchedUpdated.bigqueryConfig?.writeMetadata ?? false).toBe(false);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.subscription.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 300_000 },
);
