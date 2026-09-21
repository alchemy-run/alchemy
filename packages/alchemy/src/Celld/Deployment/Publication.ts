import * as Node from "@distilled.cloud/celld/node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  sameImmutableManifest,
  stageDeployment,
  type PreparedDeployment,
} from "../Deployment.ts";
import type { Store, StoredObject } from "../FleetStorage.ts";
import {
  bytes,
  conditionalPut,
  decode,
  digest,
  encode,
  ensureImmutable,
  equalBytes,
  refuse,
  text,
  validate,
} from "./Objects.ts";

export const APPLICATION_CLAIM_KEY = "alchemy/application/v1/claim.json";
export const APPLICATION_LOCK_KEY = "alchemy/application/v1/publisher.json";
export const APPLICATION_RECEIPT_KEY = "alchemy/application/v1/current.json";
export const BOOTSTRAP_MARKER_KEY = "alchemy/bootstrap/v1/descriptor.json";
export const ROOT_POINTER_KEY = "deploy/current.json";

export const BootstrapDescriptorSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeVersion: Schema.Literal("0.5.0"),
  bucket: Schema.Struct({
    uri: Schema.String,
    region: Schema.optional(Schema.String),
    endpoint: Schema.optional(Schema.String),
  }),
  pointer: Schema.toType(Node.DeployPointer),
});
const OwnerSchema = Schema.Struct({
  stack: Schema.String,
  stage: Schema.String,
  fqn: Schema.String,
  instanceId: Schema.String,
});
const ObjectSchema = Schema.Struct({
  key: Schema.String,
  body: Schema.String,
  etag: Schema.String,
});
const ReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  owner: OwnerSchema,
  revision: Schema.String,
  transactionId: Schema.String,
  root: Schema.toType(Node.DeployPointer),
  workers: Schema.Array(Schema.toType(Node.DeployPointer)),
  objects: Schema.Array(ObjectSchema),
});
const StepSchema = Schema.Struct({
  key: Schema.String,
  body: Schema.String,
  before: Schema.optional(
    Schema.Struct({ body: Schema.String, etag: Schema.String }),
  ),
  etag: Schema.optional(Schema.String),
});
const JournalSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  owner: OwnerSchema,
  fingerprint: Schema.String,
  revision: Schema.String,
  transactionId: Schema.String,
  root: Schema.toType(Node.DeployPointer),
  workers: Schema.Array(Schema.toType(Node.DeployPointer)),
  previous: Schema.Array(Schema.toType(Node.DeployPointer)),
  retainedObjects: Schema.Array(ObjectSchema),
  receiptBefore: Schema.optional(
    Schema.Struct({ body: Schema.String, etag: Schema.String }),
  ),
  steps: Schema.Array(StepSchema),
  complete: Schema.Boolean,
});
export type ApplicationOwner = typeof OwnerSchema.Type;
export type PublicationReceipt = typeof ReceiptSchema.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Step = Mutable<typeof StepSchema.Type>;
type Journal = Mutable<Omit<typeof JournalSchema.Type, "steps">> & {
  steps: Step[];
};
const mutableJournal = (journal: typeof JournalSchema.Type): Journal => ({
  ...journal,
  steps: journal.steps.map((step) => ({ ...step })),
});
const LockSchema = Schema.Struct({
  owner: OwnerSchema,
  transactionId: Schema.String,
  fingerprint: Schema.String,
  priorRevision: Schema.optional(Schema.String),
});

export interface PublishApplicationOptions {
  /** Complete prepared root deployment; only the root's crons execute natively. */
  readonly rootPreparedDeployment: PreparedDeployment;
  /** Complete service and queue-consumer graph, excluding the root. */
  readonly workers: readonly PreparedDeployment[];
  /** Permanent exclusive Application ownership, including replacement generation. */
  readonly owner: ApplicationOwner;
  /** Caller-persisted operation token. Reuse only to resume this exact transaction. */
  readonly transactionId: string;
  /** Last observed publication revision; required when there is a previous receipt. */
  readonly priorRevision?: string;
  /** Explicit permission to replace an unclaimed non-bootstrap root, not a foreign claim or queue. */
  readonly adopt?: boolean;
}
export interface PublicationResult {
  /** Alchemy publication identity, including cron-only changes. */
  readonly revision: string;
  /** Durable evidence of each conditional native write; not node-adoption evidence. */
  readonly receipt: PublicationReceipt;
  /** Root and worker references selected before this transaction. */
  readonly previous: readonly Node.DeployPointer[];
}

const same = (a: unknown, b: unknown) =>
  Effect.gen(function* () {
    return yield* equalBytes(yield* encode(a), yield* encode(b));
  });
const snapshot = (object: StoredObject) =>
  Effect.gen(function* () {
    return { body: yield* text(object.body), etag: object.etag };
  });
const observeReceipt = (store: Store) =>
  Effect.gen(function* () {
    const object = yield* store.get(APPLICATION_RECEIPT_KEY);
    return object
      ? { object, receipt: yield* decode(ReceiptSchema, object.body) }
      : undefined;
  });

/** Read durable publication ownership and recovery metadata, not node-adoption readiness. */
export const readPublicationReceipt = (store: Store) =>
  observeReceipt(store).pipe(Effect.map((observed) => observed?.receipt));

/** Observe an owned interrupted operation, including a receipt committed before lock release. */
export const readPublicationRecovery = (
  store: Store,
  owner: ApplicationOwner,
) =>
  Effect.gen(function* () {
    const object = yield* store.get(APPLICATION_LOCK_KEY);
    if (!object) return undefined;
    const lock = yield* decode(LockSchema, object.body);
    if (!(yield* same(lock.owner, owner)))
      return yield* refuse(
        "locked",
        "Another Application owns the nonexpiring publisher lock.",
      );
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(lock.transactionId))
      return yield* refuse(
        "invalid-record",
        "Publisher lock has an unsafe transaction ID.",
      );
    const journalObject = yield* store.get(
      `alchemy/application/v1/transactions/${lock.transactionId}.json`,
    );
    const journal = journalObject
      ? yield* decode(JournalSchema, journalObject.body)
      : undefined;
    if (
      journal &&
      (journal.transactionId !== lock.transactionId ||
        journal.fingerprint !== lock.fingerprint ||
        !(yield* same(journal.owner, owner)))
    )
      return yield* refuse(
        "invalid-record",
        "Publisher lock and journal disagree.",
      );
    const before = journal?.receiptBefore
      ? yield* decode(ReceiptSchema, yield* bytes(journal.receiptBefore.body))
      : undefined;
    const priorRevision = journal ? before?.revision : lock.priorRevision;
    if (
      lock.priorRevision !== undefined &&
      lock.priorRevision !== priorRevision
    )
      return yield* refuse(
        "invalid-record",
        "Publisher lock has a different prior revision from its journal.",
      );
    return {
      transactionId: lock.transactionId,
      ...(priorRevision === undefined ? {} : { priorRevision }),
    };
  });

/** Recover a completed current transaction's original baseline for locked activation replay. */
export const readPublicationTransaction = (
  store: Store,
  receipt: PublicationReceipt,
) =>
  Effect.gen(function* () {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(receipt.transactionId))
      return yield* refuse(
        "invalid-record",
        "Receipt has an unsafe transaction ID.",
      );
    const object = yield* store.get(
      `alchemy/application/v1/transactions/${receipt.transactionId}.json`,
    );
    if (!object)
      return yield* refuse(
        "invalid-record",
        "Current publication journal is missing.",
      );
    const journal = yield* decode(JournalSchema, object.body);
    if (
      !journal.complete ||
      journal.transactionId !== receipt.transactionId ||
      journal.revision !== receipt.revision ||
      !(yield* same(journal.owner, receipt.owner)) ||
      !(yield* same(journal.root, receipt.root)) ||
      !(yield* same(journal.workers, receipt.workers))
    )
      return yield* refuse(
        "invalid-record",
        "Current publication journal disagrees with its receipt.",
      );
    const before = journal.receiptBefore
      ? yield* decode(ReceiptSchema, yield* bytes(journal.receiptBefore.body))
      : undefined;
    return {
      transactionId: journal.transactionId,
      ...(before ? { priorRevision: before.revision } : {}),
    };
  });

/** Verify receipt evidence without mistaking it for fleet activation. */
export const verifyPublicationReceipt = (
  store: Store,
  receipt: PublicationReceipt,
) =>
  Effect.gen(function* () {
    for (const object of receipt.objects) {
      const observed = yield* store.get(object.key);
      if (
        !observed ||
        observed.etag !== object.etag ||
        !(yield* equalBytes(observed.body, yield* bytes(object.body)))
      )
        return yield* refuse(
          "drift",
          `Previously published object changed: ${object.key}`,
        );
    }
  });

const checkGraph = (options: PublishApplicationOptions) =>
  Effect.gen(function* () {
    const all = [options.rootPreparedDeployment, ...options.workers];
    const scripts = new Map(
      all.map((prepared) => [prepared.scriptName, prepared]),
    );
    if (scripts.size !== all.length)
      return yield* refuse(
        "configuration",
        "Application repeats a script identity.",
      );
    if (options.workers.some((worker) => worker.manifest.crons?.length))
      return yield* refuse(
        "unsupported",
        "Celld v0.5 runs only the root schedule; non-root cron triggers are refused.",
      );
    const classes = new Set<string>();
    const queues = new Set<string>();
    for (const prepared of all) {
      for (const name of prepared.manifest.do_classes) {
        if (["__D1Database", "__KvNamespace", "__Queue"].includes(name))
          continue;
        if (classes.has(name))
          return yield* refuse(
            "configuration",
            `Durable Object class collision in Application: ${name}`,
          );
        classes.add(name);
      }
      for (const consumer of prepared.manifest.queue_consumers ?? []) {
        if (queues.has(consumer.queue))
          return yield* refuse(
            "configuration",
            `Multiple consumers for queue ${consumer.queue}`,
          );
        queues.add(consumer.queue);
      }
    }
    // Every service target must be supplied so its named pointer is in this journal.
    for (const prepared of all) {
      const metadata = yield* validate(
        Schema.Struct({
          bindings: Schema.optional(Schema.Array(Schema.Unknown)),
        }),
        prepared.manifest.raw_metadata,
      );
      for (const binding of metadata.bindings ?? []) {
        const service = yield* validate(
          Schema.Struct({
            type: Schema.String,
            service: Schema.optional(Schema.String),
          }),
          binding,
        );
        if (
          service.type === "service" &&
          (!service.service || !scripts.has(service.service))
        )
          return yield* refuse(
            "unsupported",
            "All service-binding targets must be prepared members of this Application.",
          );
      }
    }
    return all;
  });

const checkCronTransition = (
  store: Store,
  previous: PublicationReceipt | undefined,
  root: StoredObject | undefined,
  options: PublishApplicationOptions,
) =>
  Effect.gen(function* () {
    let manifest: Node.Manifest;
    if (previous) {
      if (!(yield* same(previous.owner, options.owner)))
        return yield* refuse(
          "ownership",
          "Publication receipt belongs to a different Application instance.",
        );
      const record = previous.objects.find(
        (object) => object.key === `${previous.root.prefix}/manifest.json`,
      );
      if (!record)
        return yield* refuse(
          "invalid-record",
          "Previous publication lacks its manifest evidence.",
        );
      manifest = yield* decode(Node.Manifest, yield* bytes(record.body));
    } else {
      // Unclaimed non-bootstrap roots require explicit adoption during planning.
      if (!root || !options.adopt) return;
      const pointer = yield* decode(Node.DeployPointer, root.body);
      const record = yield* store.get(`${pointer.prefix}/manifest.json`);
      if (!record)
        return yield* refuse(
          "invalid-record",
          "Unclaimed root is missing its native manifest.",
        );
      manifest = yield* decode(Node.Manifest, record.body);
      if (
        manifest.version !== pointer.version ||
        (pointer.script_name !== undefined &&
          manifest.script_name !== pointer.script_name)
      )
        return yield* refuse(
          "invalid-record",
          "Unclaimed root pointer disagrees with its native manifest.",
        );
    }
    const scriptName = previous?.root.script_name ?? manifest.script_name;
    const next = options.rootPreparedDeployment;
    if (
      manifest.crons?.length &&
      (scriptName !== next.scriptName || !next.manifest.crons?.length)
    )
      return yield* refuse(
        "unsupported",
        `Celld v0.5.0 cannot safely retire the previous root's persisted cron cell .cron:${scriptName} when changing its script identity or removing all cron triggers. Keep root script ${scriptName} and at least one cron trigger; this transition requires verified native cron retirement support.`,
      );
  });

const planPublication = (
  store: Store,
  options: PublishApplicationOptions,
  fingerprint: string,
  revision: string,
  all: readonly PreparedDeployment[],
) =>
  Effect.gen(function* () {
    const previous = yield* observeReceipt(store);
    if (previous && !(yield* same(previous.receipt.owner, options.owner)))
      return yield* refuse(
        "ownership",
        "Publication receipt belongs to a different Application instance.",
      );
    if (previous?.receipt.revision !== options.priorRevision)
      return yield* refuse(
        "drift",
        "Publication revision changed or the prior revision was not supplied.",
      );
    const root = yield* store.get(ROOT_POINTER_KEY);
    yield* checkCronTransition(store, previous?.receipt, root, options);
    const known = new Map(
      previous?.receipt.objects.map((object) => [object.key, object]) ?? [],
    );
    for (const object of known.values()) {
      const observed = yield* store.get(object.key);
      if (
        !observed ||
        observed.etag !== object.etag ||
        !(yield* equalBytes(observed.body, yield* bytes(object.body)))
      )
        return yield* refuse(
          "drift",
          `Previously published object changed: ${object.key}`,
        );
    }
    if (previous) {
      for (const pointer of [
        previous.receipt.root,
        ...previous.receipt.workers,
      ]) {
        const record = known.get(`${pointer.prefix}/manifest.json`);
        if (!record)
          return yield* refuse(
            "invalid-record",
            "Previous publication lacks its manifest evidence.",
          );
        const oldManifest = yield* decode(
          Node.Manifest,
          yield* bytes(record.body),
        );
        if (!oldManifest.containers?.length) continue;
        const next = all.find(
          (deployment) => deployment.scriptName === pointer.script_name,
        )?.manifest;
        for (const old of oldManifest.containers) {
          const desired = next?.containers?.find(
            (container) => container.class_name === old.class_name,
          );
          if (
            !desired ||
            !(yield* same(old, desired)) ||
            next?.fence_image !== oldManifest.fence_image
          )
            return yield* refuse(
              "unsupported",
              `Changing or removing cached container class ${old.class_name} requires explicit operator quiescence; publication alone cannot retire native containers.`,
            );
        }
      }
    }
    if (root && !previous) {
      const markerObject = yield* store.get(BOOTSTRAP_MARKER_KEY);
      const marker = markerObject
        ? yield* decode(BootstrapDescriptorSchema, markerObject.body)
        : undefined;
      const bootstrap =
        marker &&
        (yield* same(
          yield* decode(Node.DeployPointer, root.body),
          marker.pointer,
        ));
      if (!bootstrap && !options.adopt)
        return yield* refuse(
          "ownership",
          "An unclaimed non-bootstrap root already exists; explicit adoption is required.",
        );
    }
    const steps: Step[] = [];
    const addStep = (
      key: string,
      body: Uint8Array,
      observed: StoredObject | undefined,
    ) =>
      Effect.gen(function* () {
        steps.push({
          key,
          body: yield* text(body),
          ...(observed ? { before: yield* snapshot(observed) } : {}),
        });
      });
    for (const prepared of all) {
      const key = `${prepared.prefix}/manifest.json`;
      const observed = yield* store.get(key);
      if (
        !observed ||
        !(yield* sameImmutableManifest(
          yield* decode(Node.Manifest, observed.body),
          prepared.manifest,
        ))
      )
        return yield* refuse(
          "collision",
          `Incomplete or incompatible staged deployment: ${key}`,
        );
      yield* addStep(key, prepared.candidate.body, observed);
      if (prepared.artifactDescriptor) {
        const descriptor = yield* store.get(prepared.artifactDescriptor.key);
        if (
          !descriptor ||
          !(yield* equalBytes(
            descriptor.body,
            prepared.artifactDescriptor.body,
          ))
        )
          return yield* refuse(
            "invalid-record",
            "Staged container archive descriptors changed before publication.",
          );
        yield* addStep(
          prepared.artifactDescriptor.key,
          prepared.artifactDescriptor.body,
          descriptor,
        );
      }
    }
    const desiredQueues = new Map(
      all.flatMap((prepared) =>
        (prepared.manifest.queue_consumers ?? []).map(
          (consumer) => [consumer.queue, prepared] as const,
        ),
      ),
    );
    const referencedQueues = new Set<string>();
    for (const prepared of all) {
      const metadata = yield* validate(
        Schema.Struct({
          bindings: Schema.optional(Schema.Array(Schema.Unknown)),
        }),
        prepared.manifest.raw_metadata,
      );
      for (const binding of metadata.bindings ?? []) {
        const native = yield* validate(
          Schema.Struct({
            type: Schema.String,
            queue: Schema.optional(Schema.String),
          }),
          binding,
        );
        if (native.type === "queue" && native.queue)
          referencedQueues.add(native.queue);
      }
      for (const consumer of prepared.manifest.queue_consumers ?? [])
        if (consumer.dead_letter_queue)
          referencedQueues.add(consumer.dead_letter_queue);
    }
    for (const queue of referencedQueues) {
      if (desiredQueues.has(queue)) continue;
      const key = `deploy/queues/${queue}/consumer.json`;
      const observed = yield* store.get(key);
      if (!observed) continue;
      const attachment = yield* decode(
        Node.QueueConsumerAttachment,
        observed.body,
      );
      if (attachment.schema_version !== 1 || attachment.queue !== queue)
        return yield* refuse(
          "invalid-record",
          `Invalid referenced queue attachment: ${key}`,
        );
      if (attachment.consumer && !known.has(key))
        return yield* refuse(
          "unsupported",
          `Queue ${queue} reaches a consumer outside the owned Application graph.`,
        );
    }
    const previousQueueKeys = [...known.keys()].filter(
      (key) =>
        key.startsWith("deploy/queues/") && key.endsWith("/consumer.json"),
    );
    const queueKeys = new Set([
      ...previousQueueKeys,
      ...[...desiredQueues.keys()].map(
        (queue) => `deploy/queues/${queue}/consumer.json`,
      ),
    ]);
    for (const key of [...queueKeys].sort()) {
      const queue = key.slice(
        "deploy/queues/".length,
        -"/consumer.json".length,
      );
      const prepared = desiredQueues.get(queue);
      const observed = yield* store.get(key);
      const attachment = observed
        ? yield* decode(Node.QueueConsumerAttachment, observed.body)
        : undefined;
      if (
        attachment &&
        (attachment.schema_version !== 1 || attachment.queue !== queue)
      )
        return yield* refuse(
          "invalid-record",
          `Invalid queue attachment at ${key}`,
        );
      if (attachment?.consumer && !known.has(key))
        return yield* refuse(
          "ownership",
          `Queue ${queue} already has an unowned consumer, even if its script name matches.`,
        );
      if (!prepared && !known.has(key)) continue;
      const next = yield* validate(Node.QueueConsumerAttachment, {
        schema_version: 1,
        queue,
        ...(prepared
          ? {
              consumer: {
                script_name: prepared.scriptName,
                version: prepared.version,
                prefix: prepared.prefix,
              },
            }
          : {}),
      });
      yield* addStep(key, yield* encode(next), observed);
    }
    for (const prepared of all) {
      const key = `deploy/${prepared.scriptName}/current.json`;
      const observed = yield* store.get(key);
      if (observed && !known.has(key)) {
        const existing = yield* decode(Node.DeployPointer, observed.body);
        const markerObject = yield* store.get(BOOTSTRAP_MARKER_KEY);
        const marker = markerObject
          ? yield* decode(BootstrapDescriptorSchema, markerObject.body)
          : undefined;
        if (
          !(marker && (yield* same(existing, marker.pointer))) &&
          !options.adopt
        )
          return yield* refuse("ownership", `Unclaimed named pointer: ${key}`);
      }
      yield* addStep(key, yield* encode(prepared.pointer), observed);
    }
    yield* addStep(
      ROOT_POINTER_KEY,
      yield* encode(options.rootPreparedDeployment.pointer),
      root,
    );
    const journal: Journal = {
      schemaVersion: 1,
      owner: options.owner,
      fingerprint,
      revision,
      transactionId: options.transactionId,
      root: options.rootPreparedDeployment.pointer,
      workers: options.workers.map((worker) => worker.pointer),
      previous: previous
        ? [previous.receipt.root, ...previous.receipt.workers]
        : root
          ? [yield* decode(Node.DeployPointer, root.body)]
          : [],
      retainedObjects: previous?.receipt.objects ?? [],
      ...(previous ? { receiptBefore: yield* snapshot(previous.object) } : {}),
      steps,
      complete: false,
    };
    return journal;
  });

/**
 * Journaled, conditional native publication under a nonexpiring exclusive lock.
 * Partial writes can be visible to nodes. Resume with the same transactionId;
 * a different publisher requires explicit operator lock recovery, never a timeout.
 * onPublished runs after the receipt commits while the publisher lock is held.
 * Callback failure retains the lock; resuming the transaction invokes it again.
 */
export const publishApplication = <E = never, R = never>(
  store: Store,
  options: PublishApplicationOptions,
  onPublished?: (result: PublicationResult) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    yield* validate(OwnerSchema, options.owner);
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.transactionId) ||
      Object.values(options.owner).some((value) => !value)
    )
      return yield* refuse(
        "configuration",
        "Publication requires a nonempty owner and a safe persisted transactionId.",
      );
    const all = yield* checkGraph(options);
    const fingerprint = yield* digest(
      yield* encode({
        owner: options.owner,
        root: options.rootPreparedDeployment.pointer,
        manifests: all.map((prepared) => prepared.manifest),
        priorRevision: options.priorRevision ?? null,
        adopt: options.adopt ?? false,
      }),
    );
    const revision = yield* digest(
      yield* encode({ fingerprint, transactionId: options.transactionId }),
    );
    const journalKey = `alchemy/application/v1/transactions/${options.transactionId}.json`;
    const claimBody = yield* encode(options.owner);
    const claim = yield* store.get(APPLICATION_CLAIM_KEY);
    if (claim && !(yield* equalBytes(claim.body, claimBody)))
      return yield* refuse(
        "ownership",
        "This fleet is permanently claimed by another Application FQN or instance.",
      );
    const lockBody = yield* encode({
      owner: options.owner,
      transactionId: options.transactionId,
      fingerprint,
      ...(options.priorRevision === undefined
        ? {}
        : { priorRevision: options.priorRevision }),
    });
    const observedLock = yield* store.get(APPLICATION_LOCK_KEY);
    if (observedLock) {
      const active = yield* decode(LockSchema, observedLock.body);
      if (
        active.transactionId !== options.transactionId ||
        active.fingerprint !== fingerprint ||
        !(yield* same(active.owner, options.owner)) ||
        (active.priorRevision !== undefined &&
          active.priorRevision !== options.priorRevision)
      )
        return yield* refuse(
          "locked",
          "A publisher lock is active. It has no expiry; only its transaction may resume, or an operator may recover it.",
        );
    }
    yield* checkCronTransition(
      store,
      yield* readPublicationReceipt(store),
      yield* store.get(ROOT_POINTER_KEY),
      options,
    );
    yield* ensureImmutable(store, APPLICATION_CLAIM_KEY, claimBody);
    for (const prepared of all) yield* stageDeployment(store, prepared);
    // New transactions preflight before locking; recovery uses its journal baseline.
    if (!observedLock && !(yield* store.get(journalKey)))
      yield* planPublication(store, options, fingerprint, revision, all);
    const lock = observedLock ?? {
      body: lockBody,
      ...(yield* conditionalPut(store, APPLICATION_LOCK_KEY, lockBody)),
    };
    let journalObject = yield* store.get(journalKey);
    let journal: Journal;
    if (journalObject) {
      journal = mutableJournal(
        yield* decode(JournalSchema, journalObject.body),
      );
      if (
        journal.fingerprint !== fingerprint ||
        !(yield* same(journal.owner, options.owner))
      )
        return yield* refuse(
          "ownership",
          "Transaction token was reused for different publication content or ownership.",
        );
    } else {
      journal = yield* planPublication(
        store,
        options,
        fingerprint,
        revision,
        all,
      );
      const body = yield* encode(journal);
      journalObject = {
        body,
        ...(yield* conditionalPut(store, journalKey, body)),
      };
    }
    const assertLock = () =>
      Effect.gen(function* () {
        const observed = yield* store.get(APPLICATION_LOCK_KEY);
        if (
          !observed ||
          observed.etag !== lock.etag ||
          !(yield* equalBytes(observed.body, lock.body))
        )
          return yield* refuse(
            "locked",
            "Publisher lock changed; no further writes are safe.",
          );
      });
    const saveJournal = () =>
      Effect.gen(function* () {
        const body = yield* encode(journal);
        journalObject = {
          body,
          ...(yield* conditionalPut(store, journalKey, body, journalObject)),
        };
      });
    for (const [index, step] of journal.steps.entries()) {
      yield* assertLock();
      const observed = yield* store.get(step.key);
      const body = yield* bytes(step.body);
      if (step.etag) {
        if (
          !observed ||
          observed.etag !== step.etag ||
          !(yield* equalBytes(observed.body, body))
        )
          return yield* refuse(
            "drift",
            `Completed journal step changed: ${step.key}`,
          );
        continue;
      }
      if (journal.complete)
        return yield* refuse(
          "invalid-record",
          "Completed journal contains an unacknowledged step.",
        );
      let etag: string;
      if (observed && (yield* equalBytes(observed.body, body))) {
        etag = observed.etag;
      } else {
        if (observed?.etag !== step.before?.etag)
          return yield* refuse(
            "drift",
            `Conditional publication baseline changed: ${step.key}`,
          );
        etag = (yield* conditionalPut(store, step.key, body, observed)).etag;
      }
      journal = {
        ...journal,
        steps: journal.steps.map((entry, i) =>
          i === index ? { ...entry, etag } : entry,
        ),
      };
      yield* saveJournal();
    }
    const objects = new Map(
      journal.retainedObjects.map((object) => [object.key, object]),
    );
    for (const step of journal.steps) {
      if (!step.etag)
        return yield* refuse(
          "invalid-record",
          "Journal is missing an acknowledged object ETag.",
        );
      objects.set(step.key, {
        key: step.key,
        body: step.body,
        etag: step.etag,
      });
    }
    const receipt: PublicationReceipt = {
      schemaVersion: 1,
      owner: journal.owner,
      revision: journal.revision,
      transactionId: journal.transactionId,
      root: journal.root,
      workers: journal.workers,
      objects: [...objects.values()],
    };
    if (!journal.complete) {
      yield* assertLock();
      const receiptBody = yield* encode(receipt);
      const baseline = journal.receiptBefore
        ? {
            etag: journal.receiptBefore.etag,
            body: yield* bytes(journal.receiptBefore.body),
          }
        : undefined;
      yield* conditionalPut(
        store,
        APPLICATION_RECEIPT_KEY,
        receiptBody,
        baseline,
      );
      journal = { ...journal, complete: true };
      yield* saveJournal();
    } else {
      const current = yield* observeReceipt(store);
      if (!current || !(yield* same(current.receipt, receipt)))
        return yield* refuse(
          "drift",
          "Completed transaction is no longer the current publication; it cannot be replayed.",
        );
    }
    const result: PublicationResult = {
      revision: receipt.revision,
      receipt,
      previous: journal.previous,
    };
    yield* assertLock();
    const committedReceipt = yield* observeReceipt(store);
    if (
      !committedReceipt ||
      !(yield* equalBytes(committedReceipt.object.body, yield* encode(receipt)))
    )
      return yield* refuse(
        "drift",
        "Committed publication receipt changed before activation.",
      );
    yield* verifyPublicationReceipt(store, receipt);
    if (onPublished) yield* onPublished(result);
    yield* assertLock();
    const activatedReceipt = yield* observeReceipt(store);
    if (
      !activatedReceipt ||
      activatedReceipt.object.etag !== committedReceipt.object.etag ||
      !(yield* equalBytes(
        activatedReceipt.object.body,
        committedReceipt.object.body,
      ))
    )
      return yield* refuse(
        "drift",
        "Publication receipt changed while its publisher lock was held.",
      );
    yield* verifyPublicationReceipt(store, receipt);
    yield* store.delete(APPLICATION_LOCK_KEY, { ifMatch: lock.etag }).pipe(
      Effect.catchTag("Celld.FleetStorageError", (error) =>
        Effect.gen(function* () {
          if (
            error.reason === "transport" &&
            !(yield* store.get(APPLICATION_LOCK_KEY))
          )
            return;
          return yield* Effect.fail(error);
        }),
      ),
    );
    return result;
  });
