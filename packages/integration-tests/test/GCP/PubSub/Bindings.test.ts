import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectAuditEntry } from "../auditLogs.ts";
import { callProbe, expectProbe } from "../bindingHost.ts";
import PubSubBindingsHost, {
  AuditMarkers,
  COMMITTED_DEFINITION,
  DetachInbox,
  EventSchema,
  GenInbox,
  GenSchema,
  GenSnapshot,
  GenTopic,
  PUBLISH_PAYLOAD,
  PublishTap,
  PublishTopic,
  PullInbox,
  PullTopic,
  ReadInbox,
  ReadTopic,
  WRITE_BATCH_BYTES,
  WRITE_BATCH_TEXT,
  WRITE_PAYLOAD,
  WriteTap,
  WriteTopicTarget,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PubSubBindings");

let baseUrl: string;
let member: string;
let names: {
  publishTopic: string;
  publishTap: string;
  writeTopic: string;
  writeTap: string;
  pullTopic: string;
  pullInbox: string;
  readTopic: string;
  readInbox: string;
  schema: string;
  genTopic: string;
  genInbox: string;
  detachInbox: string;
  genSnapshot: string;
  genSchema: string;
  auditMarkers: string;
};

const decode = (data: string | undefined) => Buffer.from(data ?? "", "base64").toString("utf8");

/** Roles `member` holds on a resource's IAM policy. */
const rolesOf = (policy: { bindings?: { role?: string; members?: string[] }[] }, member: string) =>
  (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role)
    .sort();

/** Pull (out of band) until `count` messages arrived, acknowledging them. */
const drain = (subscription: string, count: number) =>
  Effect.gen(function* () {
    const seen: pubsub.ReceivedMessage[] = [];
    yield* pubsub
      .pullProjectsSubscriptions({
        subscription,
        body: { maxMessages: 10, returnImmediately: false },
      })
      .pipe(
        Effect.tap((page) =>
          Effect.gen(function* () {
            const received = page.receivedMessages ?? [];
            seen.push(...received);
            if (received.length > 0) {
              yield* pubsub.acknowledgeProjectsSubscriptions({
                subscription,
                body: { ackIds: received.map((m) => m.ackId ?? "") },
              });
            }
          }),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: () => seen.length >= count,
          times: 30,
        }),
      );
    return seen;
  });

/** Publish (out of band, as the deployer) one message. */
const publishOutOfBand = (topic: string, text: string) =>
  pubsub.publishProjectsTopics({
    topic,
    body: { messages: [{ data: Buffer.from(text).toString("base64") }] },
  });

/** Nothing is redelivered once the ack deadline (10s) has passed. */
const expectNoRedelivery = (subscription: string) =>
  Effect.gen(function* () {
    yield* Effect.sleep("15 seconds");
    const page = yield* pubsub.pullProjectsSubscriptions({
      subscription,
      body: { maxMessages: 10, returnImmediately: true },
    });
    expect(page.receivedMessages ?? []).toEqual([]);
  });

describe(
  "PubSub Bindings",
  { tags: ["provider:gcp", "provider:gcp:pubsub", "provider:gcp:run", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* PubSubBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              publishTopic: (yield* PublishTopic).name,
              publishTap: (yield* PublishTap).name,
              writeTopic: (yield* WriteTopicTarget).name,
              writeTap: (yield* WriteTap).name,
              pullTopic: (yield* PullTopic).name,
              pullInbox: (yield* PullInbox).name,
              readTopic: (yield* ReadTopic).name,
              readInbox: (yield* ReadInbox).name,
              schema: (yield* EventSchema).name,
              genTopic: (yield* GenTopic).name,
              genInbox: (yield* GenInbox).name,
              detachInbox: (yield* DetachInbox).name,
              genSnapshot: (yield* GenSnapshot).name,
              genSchema: (yield* GenSchema).name,
              auditMarkers: (yield* AuditMarkers).bucketName,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        names = out;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Publish", () => {
      test.provider(
        "publishes to the topic, granted publisher on the topic only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ messageIds?: string[] }>(baseUrl, "publish");
            expect(out.messageIds).toHaveLength(1);

            const [message] = yield* drain(names.publishTap, 1);
            expect(message?.message?.messageId).toEqual(out.messageIds?.[0]);
            expect(decode(message?.message?.data)).toEqual(PUBLISH_PAYLOAD);
            expect(message?.message?.attributes).toEqual({ via: "Publish" });

            const policy = yield* pubsub.getIamPolicyProjectsTopics({
              resource: names.publishTopic,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.publisher"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("Pull / Acknowledge", () => {
      test.provider(
        "pulls and acknowledges, granted subscriber on the subscription only",
        (_stack) =>
          Effect.gen(function* () {
            yield* publishOutOfBand(names.pullTopic, "pull-me");
            const texts = yield* expectProbe<string[]>(baseUrl, "pullAndAcknowledge");
            expect(texts).toEqual(["pull-me"]);
            yield* expectNoRedelivery(names.pullInbox);

            const policy = yield* pubsub.getIamPolicyProjectsSubscriptions({
              resource: names.pullInbox,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.subscriber"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteTopic", () => {
      test.provider(
        "publish and publishBatch, granted publisher on the topic only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              id: string;
              batch: string[];
              empty: string[];
            }>(baseUrl, "writeTopic");
            expect(out.batch).toHaveLength(2);
            // An empty batch is a no-op, not a request.
            expect(out.empty).toEqual([]);

            // Out of band: every message landed with its payload intact.
            const received = yield* drain(names.writeTap, 3);
            const byId = new Map(received.map((m) => [m.message?.messageId, m.message]));
            expect(decode(byId.get(out.id)?.data)).toEqual(WRITE_PAYLOAD);
            expect(byId.get(out.id)?.attributes).toEqual({ via: "WriteTopic" });
            expect(decode(byId.get(out.batch[0])?.data)).toEqual(WRITE_BATCH_TEXT);
            expect([...Buffer.from(byId.get(out.batch[1])?.data ?? "", "base64")]).toEqual(
              WRITE_BATCH_BYTES,
            );

            const policy = yield* pubsub.getIamPolicyProjectsTopics({
              resource: names.writeTopic,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.publisher"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadSubscription", () => {
      test.provider(
        "pull, modifyAckDeadline and acknowledge, granted subscriber on the subscription only",
        (_stack) =>
          Effect.gen(function* () {
            yield* publishOutOfBand(names.readTopic, "read-me");
            const messages = yield* expectProbe<
              { text: string; attributes: Record<string, string> }[]
            >(baseUrl, "readSubscription");
            expect(messages).toEqual([{ text: "read-me", attributes: {} }]);
            yield* expectNoRedelivery(names.readInbox);

            const policy = yield* pubsub.getIamPolicyProjectsSubscriptions({
              resource: names.readInbox,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.subscriber"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetSchema", () => {
      test.provider(
        "reads the schema, granted viewer on the schema",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<pubsub.Pubsub_Schema>(baseUrl, "getSchema");
            expect(live.name).toEqual(names.schema);
            expect(live.type).toEqual("AVRO");
            expect(JSON.parse(live.definition ?? "{}")).toMatchObject({
              name: "Event",
            });

            const policy = yield* pubsub.getIamPolicyProjectsSchemas({
              resource: names.schema,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.viewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ValidateMessage", () => {
      test.provider(
        "accepts a conforming message and rejects another, granted viewer on the project",
        (_stack) =>
          Effect.gen(function* () {
            const valid = yield* expectProbe<object>(baseUrl, "validateValid");
            expect(valid).toEqual({});

            const invalid = yield* callProbe(baseUrl, "validateInvalid");
            expect(invalid.ok ? "ok" : invalid.error._tag).toEqual("BadRequest");

            const { project } = yield* GcpEnvironment.current;
            const policy = yield* resourcemanager.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            // schemas.validateMessage is authorized on the parent project
            // (a viewer grant on the schema alone answers 403).
            // (DeleteSchemaRevision adds its own project-level editor grant.)
            expect(
              (policy.bindings ?? [])
                .filter((binding) => (binding.members ?? []).includes(member))
                .map((binding) => [binding.role, binding.condition]),
            ).toContainEqual(["roles/pubsub.viewer", undefined]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:pubsub", "live"],
          timeout: 600_000,
        },
      );
    });
    const live = { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 600_000 };
    const topicRoles = (resource: string) =>
      pubsub.getIamPolicyProjectsTopics({ resource }).pipe(Effect.map((p) => rolesOf(p, member)));
    const subscriptionRoles = (resource: string) =>
      pubsub
        .getIamPolicyProjectsSubscriptions({ resource })
        .pipe(Effect.map((p) => rolesOf(p, member)));

    describe("GetTopic / ListTopicSubscriptions / ListTopicSnapshots", () => {
      test.provider(
        "read the topic and what hangs off it, granted viewer on the topic only",
        (_stack) =>
          Effect.gen(function* () {
            const topic = yield* expectProbe<{ name?: string }>(baseUrl, "getTopic");
            expect(topic.name).toEqual(names.genTopic);
            const subscriptions = yield* expectProbe<{ subscriptions?: string[] }>(
              baseUrl,
              "listTopicSubscriptions",
            );
            expect(subscriptions.subscriptions).toContain(names.genInbox);
            const snapshots = yield* expectProbe<{ snapshots?: string[] }>(
              baseUrl,
              "listTopicSnapshots",
            );
            expect(snapshots.snapshots).toContain(names.genSnapshot);
            // Viewer for these reads; editor for DetachSubscription, which is
            // authorized on the subscription's topic.
            expect(yield* topicRoles(names.genTopic)).toEqual([
              "roles/pubsub.editor",
              "roles/pubsub.viewer",
            ]);
          }),
        live,
      );
    });

    describe("GetSubscription / SeekSubscription / ModifySubscriptionPushConfig", () => {
      test.provider(
        "read, seek and reconfigure the subscription, granted on the subscription only",
        (_stack) =>
          Effect.gen(function* () {
            const subscription = yield* expectProbe<{ name?: string; topic?: string }>(
              baseUrl,
              "getSubscription",
            );
            expect(subscription).toMatchObject({ name: names.genInbox, topic: names.genTopic });
            yield* expectProbe(baseUrl, "seekSubscription");
            yield* expectProbe(baseUrl, "modifySubscriptionPushConfig");
            const live = yield* pubsub.getProjectsSubscriptions({ subscription: names.genInbox });
            expect(live.pushConfig?.pushEndpoint).toBeUndefined();
            expect(yield* subscriptionRoles(names.genInbox)).toEqual([
              "roles/pubsub.editor",
              "roles/pubsub.subscriber",
              "roles/pubsub.viewer",
            ]);
          }),
        live,
      );
    });

    describe("DetachSubscription", () => {
      test.provider(
        "detaches the subscription, granted editor on its topic",
        (_stack) =>
          Effect.gen(function* () {
            yield* expectProbe(baseUrl, "detachSubscription");
            const live = yield* pubsub.getProjectsSubscriptions({
              subscription: names.detachInbox,
            });
            expect(live.detached).toBe(true);
            expect(yield* subscriptionRoles(names.detachInbox)).toEqual([]);
          }),
        live,
      );
    });

    describe("GetSnapshot", () => {
      test.provider(
        "reads the snapshot, granted viewer on the snapshot only",
        (_stack) =>
          Effect.gen(function* () {
            const snapshot = yield* expectProbe<{ name?: string; topic?: string }>(
              baseUrl,
              "getSnapshot",
            );
            expect(snapshot).toMatchObject({ name: names.genSnapshot, topic: names.genTopic });
            const policy = yield* pubsub.getIamPolicyProjectsSnapshots({
              resource: names.genSnapshot,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.viewer"]);
          }),
        live,
      );
    });

    describe("CommitSchema / ListSchemaRevisions / RollbackSchema / DeleteSchemaRevision", () => {
      test.provider(
        "commit, roll back and delete a revision, granted on the schema only",
        (_stack) =>
          Effect.gen(function* () {
            const step = <A>(route: string) =>
              expectProbe<A>(baseUrl, route).pipe(Effect.timeout("90 seconds"));
            const { original, committed } = yield* step<{ original: string; committed: string }>(
              "schemaCommit",
            );
            expect(committed).not.toEqual(original);
            const rolledBack = yield* step<{ definition?: string }>(
              `schemaRollback?revision=${original}`,
            );
            expect(rolledBack.definition).not.toEqual(COMMITTED_DEFINITION);
            const deleted = yield* step<{ revisionId?: string }>(
              `schemaDeleteRevision?revision=${committed}`,
            );
            expect(deleted.revisionId).toEqual(committed);
            const listed = yield* step<{ schemas?: { revisionId?: string }[] }>(
              "schemaListRevisions",
            );
            const remaining = (listed.schemas ?? []).map((schema) => schema.revisionId);
            expect(remaining).not.toContain(committed);
            expect(remaining).toContain(original);

            // A revision isn't covered by the schema's IAM policy, so
            // DeleteSchemaRevision is granted editor on the project.
            const { project } = yield* GcpEnvironment.current;
            const projectPolicy = yield* resourcemanager.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            expect(rolesOf(projectPolicy, member)).toContain("roles/pubsub.editor");
            const policy = yield* pubsub.getIamPolicyProjectsSchemas({
              resource: names.genSchema,
            });
            expect(rolesOf(policy, member)).toEqual(["roles/pubsub.editor", "roles/pubsub.viewer"]);
          }),
        live,
      );
    });

    describe("consumeTopicAuditLogs / consumeSubscriptionAuditLogs / consumeSchemaAuditLogs / consumeSnapshotAuditLogs", () => {
      test.provider(
        "deliver each resource's audit log entries to the host",
        (_stack) =>
          Effect.gen(function* () {
            // Re-setting a resource's own policy is an Admin Activity call that changes nothing.
            const cases = [
              {
                key: "topic",
                name: names.genTopic,
                trigger: pubsub.getIamPolicyProjectsTopics({ resource: names.genTopic }).pipe(
                  Effect.flatMap((policy) =>
                    pubsub.setIamPolicyProjectsTopics({
                      resource: names.genTopic,
                      body: { policy },
                    }),
                  ),
                ),
              },
              {
                key: "subscription",
                name: names.genInbox,
                trigger: pubsub
                  .getIamPolicyProjectsSubscriptions({ resource: names.genInbox })
                  .pipe(
                    Effect.flatMap((policy) =>
                      pubsub.setIamPolicyProjectsSubscriptions({
                        resource: names.genInbox,
                        body: { policy },
                      }),
                    ),
                  ),
              },
              {
                key: "schema",
                name: names.genSchema,
                trigger: pubsub.getIamPolicyProjectsSchemas({ resource: names.genSchema }).pipe(
                  Effect.flatMap((policy) =>
                    pubsub.setIamPolicyProjectsSchemas({
                      resource: names.genSchema,
                      body: { policy },
                    }),
                  ),
                ),
              },
              {
                key: "snapshot",
                name: names.genSnapshot,
                trigger: pubsub.getIamPolicyProjectsSnapshots({ resource: names.genSnapshot }).pipe(
                  Effect.flatMap((policy) =>
                    pubsub.setIamPolicyProjectsSnapshots({
                      resource: names.genSnapshot,
                      body: { policy },
                    }),
                  ),
                ),
              },
            ];
            for (const { key, name, trigger } of cases) {
              const entry = yield* expectAuditEntry({
                bucket: names.auditMarkers,
                key,
                method: "SetIamPolicy",
                trigger,
              });
              expect(entry.serviceName).toEqual("pubsub.googleapis.com");
              // Audit logs may name the project by number.
              const path = (value: string) => value.replace(/^projects\/[^/]+/, "");
              expect(path(entry.resourceName)).toEqual(path(name));
            }
          }),
        { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 900_000 },
      );
    });
  },
);
