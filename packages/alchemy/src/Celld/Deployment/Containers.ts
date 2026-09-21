import * as Node from "@distilled.cloud/celld/node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Store } from "../FleetStorage.ts";
import {
  decode,
  digest,
  encode,
  ensureImmutable,
  refuse,
  validate,
} from "./Objects.ts";

/** Immutable native image identity plus the checksum of its exact Docker save bytes. */
export interface ContainerArtifactDescriptor {
  /** Native celld-image:<sha256> tag, derived by the image builder from Docker inspect output. */
  readonly image: string;
  /** Native deploy/images/<image-identity>.tar key. */
  readonly key: string;
  /** SHA-256 of the raw save archive, not the image identity. */
  readonly sha256: string;
  /** Exact raw archive byte length. */
  readonly bytes: number;
}

export const ContainerArtifactSchema = Schema.Struct({
  image: Schema.String,
  key: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
});
export const ContainerArtifactsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  artifacts: Schema.Array(ContainerArtifactSchema),
});
export const containerArtifactsKey = (candidateKey: string) =>
  `${candidateKey}.artifacts.json`;

export const validateContainerArtifact = (
  artifact: ContainerArtifactDescriptor,
) =>
  Effect.gen(function* () {
    yield* validate(ContainerArtifactSchema, artifact);
    if (
      !/^celld-image:[a-f0-9]{64}$/.test(artifact.image) ||
      artifact.key !==
        `deploy/images/${artifact.image.slice("celld-image:".length)}.tar` ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0
    )
      return yield* refuse(
        "configuration",
        "Container artifact identity, native key, checksum, or size is invalid.",
      );
    return artifact;
  });

export const verifyContainerArchive = (
  artifact: ContainerArtifactDescriptor,
  body: Uint8Array,
) =>
  Effect.gen(function* () {
    yield* validateContainerArtifact(artifact);
    if (
      body.length !== artifact.bytes ||
      (yield* digest(body)) !== artifact.sha256
    )
      return yield* refuse(
        "invalid-record",
        `Container archive differs from its verified descriptor: ${artifact.key}`,
      );
  });

const ContainerImageRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  artifact: ContainerArtifactSchema,
});

/** Permanent first-archive provenance for a native image identity. @internal */
export const containerImageRecordKey = (image: string) =>
  `alchemy/container-images/${image.slice("celld-image:".length)}.json`;

/** Recovery bytes are committed before the first-archive descriptor. @internal */
export const containerArchiveRecoveryKey = (sha256: string) =>
  `alchemy/container-images/archives/${sha256}.tar`;

const readContainerImageRecord = (image: string, body: Uint8Array) =>
  Effect.gen(function* () {
    const { artifact } = yield* decode(ContainerImageRecordSchema, body);
    yield* validateContainerArtifact(artifact);
    if (artifact.image !== image)
      return yield* refuse(
        "invalid-record",
        "Container archive provenance names a different native image.",
      );
    return artifact;
  });

/**
 * Select the first verified save archive for each native identity. Docker save
 * bytes can differ across equivalent rebuilds. Candidates must use the returned
 * descriptors, not descriptors computed from a later local archive.
 */
export const stageContainerArtifacts = (
  store: Store,
  artifacts: readonly (ContainerArtifactDescriptor & {
    readonly body: Uint8Array;
  })[],
) =>
  Effect.forEach(artifacts, (artifact) =>
    Effect.gen(function* () {
      yield* verifyContainerArchive(artifact, artifact.body);
      const recordKey = containerImageRecordKey(artifact.image);
      let record = yield* store.get(recordKey);
      if (!record) {
        const existing = yield* store.get(artifact.key);
        if (existing) {
          // A concurrent publisher commits provenance before the native archive.
          record = yield* store.get(recordKey);
          if (!record)
            return yield* refuse(
              "ownership",
              `Container archive has no verified provenance; refusing to claim it: ${artifact.key}`,
            );
        }
      }
      if (!record) {
        yield* ensureImmutable(
          store,
          containerArchiveRecoveryKey(artifact.sha256),
          artifact.body,
        );
        const descriptor = {
          image: artifact.image,
          key: artifact.key,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        };
        const body = yield* encode({ schemaVersion: 1, artifact: descriptor });
        yield* store.put(recordKey, body, { ifNoneMatch: true }).pipe(
          Effect.catchTag("Celld.FleetStorageError", (error) => {
            if (error.reason !== "conflict" && error.reason !== "transport")
              return Effect.fail(error);
            return Effect.gen(function* () {
              const winner = yield* store.get(recordKey);
              if (!winner) return yield* Effect.fail(error);
              return { etag: winner.etag };
            });
          }),
        );
        record = yield* store.get(recordKey);
      }
      if (!record)
        return yield* refuse(
          "invalid-record",
          `Container archive provenance disappeared: ${recordKey}`,
        );
      const selected = yield* readContainerImageRecord(
        artifact.image,
        record.body,
      );
      const existing = yield* store.get(selected.key);
      if (existing) {
        yield* verifyContainerArchive(selected, existing.body);
      } else {
        const recovery = yield* store.get(
          containerArchiveRecoveryKey(selected.sha256),
        );
        if (!recovery)
          return yield* refuse(
            "invalid-record",
            `Container archive recovery bytes are missing: ${selected.key}`,
          );
        yield* verifyContainerArchive(selected, recovery.body);
        yield* ensureImmutable(store, selected.key, recovery.body);
      }
      yield* verifyStoredContainerArtifacts(store, [selected]);
      return selected;
    }),
  );

export const verifyStoredContainerArtifacts = (
  store: Store,
  artifacts: readonly ContainerArtifactDescriptor[],
) =>
  Effect.gen(function* () {
    for (const artifact of artifacts) {
      yield* validateContainerArtifact(artifact);
      const record = yield* store.get(containerImageRecordKey(artifact.image));
      if (!record)
        return yield* refuse(
          "invalid-record",
          `Container archive has no verified provenance: ${artifact.key}`,
        );
      const selected = yield* readContainerImageRecord(
        artifact.image,
        record.body,
      );
      if (
        selected.key !== artifact.key ||
        selected.sha256 !== artifact.sha256 ||
        selected.bytes !== artifact.bytes
      )
        return yield* refuse(
          "invalid-record",
          `Container candidate does not reference the first verified archive: ${artifact.key}`,
        );
      const object = yield* store.get(artifact.key);
      if (!object)
        return yield* refuse(
          "invalid-record",
          `Container archive must be uploaded before its deployment: ${artifact.key}`,
        );
      yield* verifyContainerArchive(artifact, object.body);
    }
  });

export const prepareContainers = (options: {
  readonly containers: readonly Node.ContainerSpec[];
  readonly fenceImage?: string;
  readonly artifacts: readonly ContainerArtifactDescriptor[];
  readonly doClasses: readonly string[];
  readonly sqliteClasses: readonly string[];
}) =>
  Effect.gen(function* () {
    const containers = yield* validate(Node.ContainerSpecs, options.containers);
    if (
      containers.length === 0 &&
      (options.fenceImage !== undefined || options.artifacts.length > 0)
    )
      return yield* refuse(
        "configuration",
        "Container artifacts and fence image require at least one container class.",
      );
    if (containers.length > 0 && !options.fenceImage)
      return yield* refuse(
        "configuration",
        "Native container deployments require a verified fence image.",
      );
    const images = new Set([
      ...containers.map((container) => container.image),
      ...(options.fenceImage ? [options.fenceImage] : []),
    ]);
    const artifacts = options.artifacts
      .map(({ image, key, sha256, bytes }) => ({ image, key, sha256, bytes }))
      .sort((a, b) => (a.image < b.image ? -1 : a.image > b.image ? 1 : 0));
    if (
      artifacts.length !== images.size ||
      new Set(artifacts.map((artifact) => artifact.image)).size !==
        artifacts.length
    )
      return yield* refuse(
        "configuration",
        "Supply exactly one verified archive descriptor for every container and fence image.",
      );
    for (const artifact of artifacts) {
      yield* validateContainerArtifact(artifact);
      if (!images.has(artifact.image))
        return yield* refuse(
          "configuration",
          "Container descriptor names an unreferenced image.",
        );
    }
    const classes = new Set<string>();
    const sizes = [
      "lite",
      "dev",
      "basic",
      "standard",
      "standard-1",
      "standard-2",
      "standard-3",
      "standard-4",
    ];
    for (const container of containers) {
      if (
        classes.has(container.class_name) ||
        !options.doClasses.includes(container.class_name) ||
        !options.sqliteClasses.includes(container.class_name) ||
        (container.instance_type !== undefined &&
          !sizes.includes(container.instance_type)) ||
        (container.max_instances !== undefined &&
          (!Number.isSafeInteger(container.max_instances) ||
            container.max_instances < 0)) ||
        (container.runtime !== undefined && !container.runtime.trim())
      )
        return yield* refuse(
          "configuration",
          "Container specs require unique declared SQLite classes and supported native settings.",
        );
      classes.add(container.class_name);
    }
    return { containers, artifacts };
  });
