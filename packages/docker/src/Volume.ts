import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, hasAlchemyTags, stripInternalTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { Docker, dockerContextName, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

// Docker volume names are reusable and are not physical generation IDs.
// This label identifies volumes created by this provider, not adopted volumes.
const VOLUME_INSTANCE_LABEL = "alchemy::volume-instance";

export interface VolumeLabel {
  /** Label name. */
  name: string;
  /** Label value. */
  value: string;
}

export interface VolumeProps {
  /**
   * Docker volume name.
   *
   * With the default `local` driver, the name must start with an ASCII
   * letter or digit and contain only letters, digits, `_`, `.`, and `-`.
   * Invalid local names fail at plan time, before deleting an old volume.
   * Third-party drivers may support different name formats.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /**
   * Volume driver. Changing it replaces a managed volume.
   * @default "local"
   */
  driver?: string;
  /** Driver-specific options. Changing them replaces a managed volume. */
  driverOpts?: Record<string, string>;
  /**
   * Custom metadata labels. Changing them replaces a managed volume.
   * Keys beginning with `alchemy::` are reserved for Alchemy's identity metadata.
   */
  labels?: Record<string, string>;
  /** Docker context name or context resource. */
  context?: Docker.ContextRef;
}

export interface Volume extends Resource<
  "Docker.Volume",
  VolumeProps,
  {
    /** Docker volume name. */
    id: string;
    /** Docker volume name. */
    name: string;
    /** Volume driver. */
    driver: string;
    /** Driver-specific options reported by Docker. */
    driverOpts: Record<string, string>;
    /** Labels reported by Docker. */
    labels: Record<string, string>;
    /** Host mountpoint path. */
    mountpoint?: string;
    /** Creation timestamp in milliseconds since epoch, or 0 if Docker returned an invalid time. */
    createdAt: number;
    /** Creation timestamp exactly as returned by Docker, for identity and compatibility checks. */
    createdAtRaw?: string;
  },
  never,
  Providers,
  VolumeLookup
> {}

/**
 * Props for {@link Volume.lookup}: find a volume this stack
 * doesn't manage by its name.
 */
export interface VolumeLookup {
  /** Volume name. */
  name: string;
  /**
   * Docker context the engine is reached through.
   * @default the current context
   */
  context?: string;
}

/**
 * A Docker volume managed through the active Docker context.
 *
 * Pre-existing same-name volumes are treated as foreign until the engine is
 * allowed to adopt them with `--adopt` or `adopt(true)`. This includes volumes
 * bearing this stack's labels but a different `alchemy::volume-instance`
 * generation after state loss. The previous generation is trusted only when
 * the engine supplies its persisted attributes.
 *
 * Each newly created volume receives an internal `alchemy::volume-instance`
 * label that identifies its resource generation. Alchemy verifies this identity,
 * the creation timestamp and the recorded Docker metadata before updating,
 * replacing or removing a tracked volume. Volumes adopted without this label
 * are checked against their previously observed identity instead.
 *
 * An explicitly adopted volume that originated outside the current resource
 * generation is not automatically deleted to apply changed immutable settings.
 * Alchemy fails the plan instead, so data migration is a deliberate operation.
 *
 * Docker removes volumes **by name**, not an immutable object ID: inspection
 * followed by removal is not atomic. Some Docker Engines report creation times
 * only to the second; a same-second replacement with copied labels may be
 * indistinguishable. Use `RemovalPolicy.protect()`, `retain()` and separate
 * backups for irreplaceable data.
 *
 *
 * ### Creating Volumes
 * **Example:** Basic volume
 * ```typescript
 * const data = yield* Docker.Volume("data", {
 *   name: "app-data",
 * });
 * ```
 *
 * **Example:** PostgreSQL data volume
 * ```typescript
 * const data = yield* Docker.Volume("postgres-data");
 * ```
 *
 * **Example:** Driver options and labels
 * ```typescript
 * const data = yield* Docker.Volume("db-data", {
 *   driver: "local",
 *   driverOpts: {
 *     type: "nfs",
 *     o: "addr=10.0.0.1,rw",
 *     device: ":/path/to/dir",
 *   },
 *   labels: {
 *     "com.example.usage": "database",
 *   },
 * });
 * ```
 *
 * ### Docker Context
 * **Example:** Create a volume in a named Docker context
 * ```typescript
 * const data = yield* Docker.Volume("data", {
 *   name: "app-data",
 *   context: "remote-build",
 * });
 * ```
 *
 * ### Looking up an existing volume
 * `Volume.lookup` references a volume Alchemy doesn't manage (created with
 * the Docker CLI, Compose or another stack). It is read during plan/deploy,
 * never created, updated or removed.
 *
 * **Example:** Reference an existing volume
 * ```typescript
 * const data = Docker.Volume.lookup({ name: "pgdata" });
 * ```
 *
 * ### Adopting an existing volume
 * A managed `Docker.Volume` with an existing name requires explicit adoption
 * when it belongs to another owner. Its existing labels, driver and contents
 * are preserved; adopting does not make immutable configuration changes safe.
 *
 * **Example:** Adopt an existing volume
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const data = yield* Docker.Volume("imported-data", {
 *   name: "legacy-data",
 * }).pipe(adopt(true));
 * ```
 *
 * ### Protecting data volumes
 * Changing the name, driver, driver options or labels of a volume created by
 * Alchemy normally replaces the volume. The default removal policy deletes
 * the previous physical volume. `protect()` blocks replacement or destruction;
 * `retain()` leaves the physical volume in place when its state is removed.
 *
 * **Example:** Prevent accidental volume replacement or deletion
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const data = yield* Docker.Volume("critical-data").pipe(
 *   RemovalPolicy.protect(),
 * );
 * ```
 *
 * ### Validation and ownership conflicts
 * User-defined labels cannot start with `alchemy::`. Empty names/drivers and
 * invalid label or driver-option keys fail with `InvalidVolumeOptions`, which
 * reports the offending property path. For the built-in `local` driver, volume
 * names must begin with a letter or digit and contain only letters, digits,
 * `_`, `.` or `-`; invalid names fail during planning before delete-first
 * replacement. Third-party drivers may support other name formats.
 * When the observed volume no longer matches its recorded generation, Alchemy
 * reports `OwnedBySomeoneElse` instead of modifying or removing it.
 *
 * @resource
 * @product Volume
 */
export const Volume = Resource<Volume>("Docker.Volume");

export const VolumeProvider = () =>
  Provider.effect(
    Volume,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const inspect = (name: string, context?: string) =>
        docker.volume
          .inspect(name, context)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));

      const verify = Effect.fn(function* (
        id: string,
        expected: Volume["Attributes"],
        current: Docker.Volume,
      ) {
        if (!matchesVolumeGeneration(expected, current)) {
          return yield* volumeOwnershipConflict(id, expected.name);
        }
      });

      return Volume.Provider.of({
        list: () => Effect.succeed([]),
        lookup: Effect.fn(function* ({ name, context }) {
          const info = yield* inspect(name, context);
          return info ? toVolumeAttributes(info) : undefined;
        }),

        read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
          const context = dockerContextName(olds?.context);
          const name = output?.name ?? (yield* dockerPhysicalName(id, olds, instanceId));
          const info = yield* inspect(name, context);
          if (!info) return undefined;
          const attrs = toVolumeAttributes(info);
          if (output) {
            yield* verify(id, output, info);
            return attrs;
          }
          if (previous?.name === attrs.name) {
            yield* verify(id, previous, info);
            return attrs;
          }
          // With no persisted state, matching stack tags alone cannot prove
          // that a generation-labelled volume is ours. A stale generation
          // could otherwise be adopted and deleted by an immutable-prop diff.
          // Untagged pre-generation volumes keep the legacy ownership route.
          const owned = yield* hasAlchemyTags(id, info.Labels ?? undefined);
          const generation = info.Labels?.[VOLUME_INSTANCE_LABEL];
          return owned && (generation === undefined || generation === instanceId)
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, output, news, olds }) {
          // A no-op plan cannot trust persisted attributes: the name may have
          // been taken over since the previous deploy. Verify even with
          // unresolved new props, and before any deleteFirst replacement.
          const current = output
            ? yield* inspect(output.name, dockerContextName(olds?.context))
            : undefined;
          if (output && current) yield* verify(id, output, current);
          // Adoption grants management of an existing volume, not permission
          // to delete data created by a different physical generation.
          // The internal stack tags alone do not establish ownership: an
          // explicitly adopted volume may carry the same stack and logical id.
          // Volumes created before generation labels existed carry only the
          // stack tags; `verify` above already matched their creation time.
          const generation = output?.labels[VOLUME_INSTANCE_LABEL];
          const ownedGeneration =
            output !== undefined &&
            (generation === instanceId || generation === undefined) &&
            (yield* hasAlchemyTags(id, output.labels));
          const foreignOrigin = output !== undefined && current !== undefined && !ownedGeneration;
          if (!isResolved(news)) {
            return output && !current ? { action: "update" as const } : undefined;
          }
          const args = yield* makeVolumeArgs(id, news, instanceId);
          if (dockerContextName(olds?.context) !== dockerContextName(news?.context)) {
            if (foreignOrigin) return yield* adoptedVolumeReplacementConflict(id, output.name);
            return { action: "replace" as const, deleteFirst: true };
          }
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const desiredName = news?.name ?? output?.name ?? args.name;
          // Imported/legacy volumes may carry metadata Alchemy didn't
          // declare. A generation from another state/stack is also imported.
          // Omitted props do not request destructive replacement.
          const imported = output !== undefined && !ownedGeneration;
          const compareDriver =
            !imported || news?.driver !== undefined || olds?.driver !== undefined;
          const compareDriverOpts =
            !imported || news?.driverOpts !== undefined || olds?.driverOpts !== undefined;
          const compareLabels =
            !imported || news?.labels !== undefined || olds?.labels !== undefined;
          if (
            output?.name !== desiredName ||
            (compareDriver && output?.driver !== args.driver) ||
            (compareDriverOpts && !Equal.equals(output?.driverOpts ?? {}, args.opt ?? {})) ||
            // Compare only user labels; internal `alchemy::*` branding lives on
            // the observed volume but must not drive replacement.
            (compareLabels && !Equal.equals(stripInternalTags(output?.labels), args.label ?? {}))
          ) {
            if (foreignOrigin) return yield* adoptedVolumeReplacementConflict(id, output.name);
            return { action: "replace" as const, deleteFirst: true };
          }
          // A missing managed volume is recreated instead of retaining a
          // stale no-op state. Only NotFound means it is safe to recover.
          if (output && !current) return { action: "update" as const };
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const context = dockerContextName(news?.context);
          const args = yield* makeVolumeArgs(id, news, instanceId);
          // Prefer the deployed name: regenerating would target a different
          // volume if the generator's output for this id ever drifts.
          const name = news?.name ?? output?.name ?? args.name;
          const existing = yield* inspect(name, context);
          if (existing) {
            if (output?.name === name) {
              yield* verify(id, output, existing);
              // Explicitly adopted and legacy volumes cannot be relabelled;
              // their original metadata is tracked in the persisted output.
              if (
                existing.Labels?.[VOLUME_INSTANCE_LABEL] === instanceId &&
                !matchesVolumeConfiguration(existing, args)
              ) {
                return yield* volumeConfigurationConflict(id, name);
              }
              return toVolumeAttributes(existing);
            }
            // An interrupted create may have created the volume before its
            // output reached state. It must have this instance's identity.
            const owned = yield* hasAlchemyTags(id, existing.Labels ?? undefined);
            if (owned && existing.Labels?.[VOLUME_INSTANCE_LABEL] === instanceId) {
              if (!matchesVolumeConfiguration(existing, args)) {
                return yield* volumeConfigurationConflict(id, name);
              }
              return toVolumeAttributes(existing);
            }
            return yield* volumeOwnershipConflict(id, name);
          }
          const internalTags = yield* createInternalTags(id);
          const result = yield* docker.volume.create({
            ...args,
            name,
            label: { ...args.label, ...internalTags, [VOLUME_INSTANCE_LABEL]: instanceId },
            context,
          });
          // docker volume create can succeed by reusing an existing name.
          // Inspect the entire identity and immutable configuration instead
          // of trusting the return code or a copied generation label alone.
          const created = yield* docker.volume.inspect(result.stdout, context);
          if (
            created.Name !== name ||
            created.Labels?.[VOLUME_INSTANCE_LABEL] !== instanceId ||
            !(yield* hasAlchemyTags(id, created.Labels ?? undefined))
          ) {
            return yield* volumeOwnershipConflict(id, name);
          }
          if (!matchesVolumeConfiguration(created, args)) {
            return yield* volumeConfigurationConflict(id, name);
          }
          return toVolumeAttributes(created);
        }),
        delete: Effect.fn(function* ({ id, olds, output }) {
          const context = dockerContextName(olds?.context);
          const current = yield* inspect(output.name, context);
          if (!current) return;
          yield* verify(id, output, current);
          yield* docker.volume
            .remove(output.name, context)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
        }),
      });
    }),
  );

// Every prop is optional, so `Docker.Volume("data")` arrives with no props.
const makeVolumeArgs = (id: string, props: VolumeProps | undefined, instanceId: string) =>
  dockerPhysicalName(id, props, instanceId).pipe(
    Effect.tap(() => validateVolumeOptions(props)),
    Effect.map((name): Parameters<Docker["Service"]["volume"]["create"]>[0] => ({
      name,
      driver: props?.driver ?? "local",
      opt: props?.driverOpts,
      label: props?.labels,
    })),
  );

/** Invalid volume configuration, rejected before any destructive replacement. */
export class InvalidVolumeOptions extends Data.TaggedError("InvalidVolumeOptions")<{
  /** Property path in the Docker.Volume declaration. */
  readonly path: string;
  /** Explanation of the rejected value. */
  readonly message: string;
}> {}

const invalidVolumeOption = (path: string, reason: string) =>
  Effect.fail(new InvalidVolumeOptions({ path, message: "Docker.Volume " + path + ": " + reason }));

const validateVolumeOptions = (props: VolumeProps | undefined) => {
  if (props?.name !== undefined && !props.name.trim()) {
    return invalidVolumeOption("name", "must not be empty");
  }
  if (
    props?.name !== undefined &&
    (props.driver ?? "local") === "local" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(props.name)
  ) {
    return invalidVolumeOption(
      "name",
      "local volume names must start with a letter or digit and contain only letters, digits, _, . or -",
    );
  }
  if (props?.driver !== undefined && !props.driver.trim()) {
    return invalidVolumeOption("driver", "must not be empty");
  }
  const reservedLabel = Object.keys(props?.labels ?? {}).find((key) => key.startsWith("alchemy::"));
  if (reservedLabel !== undefined) {
    return invalidVolumeOption(
      "labels[" + JSON.stringify(reservedLabel) + "]",
      "the alchemy:: label prefix is reserved for resource ownership",
    );
  }
  for (const [path, entries] of [
    ["labels", props?.labels],
    ["driverOpts", props?.driverOpts],
  ] as const) {
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (!key.trim() || key.includes("=") || (path === "driverOpts" && !value.trim())) {
        return invalidVolumeOption(
          path + "[" + JSON.stringify(key) + "]",
          "invalid option name or empty driver option value",
        );
      }
    }
  }
  return Effect.void;
};

const volumeOwnershipConflict = (id: string, name: string) =>
  Effect.fail(
    new OwnedBySomeoneElse({
      message:
        "Docker volume '" +
        name +
        "' no longer matches the recorded physical generation. " +
        "Refusing to modify or remove another volume with the same name.",
      resourceType: "Docker.Volume",
      logicalId: id,
      physicalName: name,
    }),
  );

const volumeConfigurationConflict = (id: string, name: string) =>
  Effect.fail(
    new OwnedBySomeoneElse({
      message:
        "Docker volume '" +
        name +
        "' already exists with incompatible immutable settings. " +
        "Refusing to claim a successful create; replace or migrate it explicitly.",
      resourceType: "Docker.Volume",
      logicalId: id,
      physicalName: name,
    }),
  );

const adoptedVolumeReplacementConflict = (id: string, name: string) =>
  Effect.fail(
    new OwnedBySomeoneElse({
      message:
        "Docker volume '" +
        name +
        "' was adopted, not created by this resource. " +
        "Refusing to delete it to apply changed immutable settings; migrate its data explicitly.",
      resourceType: "Docker.Volume",
      logicalId: id,
      physicalName: name,
    }),
  );

const matchesVolumeConfiguration = (
  info: Docker.Volume,
  args: Parameters<Docker["Service"]["volume"]["create"]>[0],
): boolean =>
  info.Driver === args.driver &&
  Equal.equals(info.Options ?? {}, args.opt ?? {}) &&
  Equal.equals(stripInternalTags(info.Labels), args.label ?? {});

// Docker volumes have no immutable physical ID. On modern managed volumes,
// the generation label is authoritative; unlabelled legacy/adopted volumes
// require stable creation metadata and their original immutable labels/driver.
const matchesVolumeGeneration = (expected: Volume["Attributes"], info: Docker.Volume): boolean => {
  const labels = info.Labels ?? {};
  if (
    expected.name !== info.Name ||
    expected.driver !== info.Driver ||
    !Equal.equals(expected.labels ?? {}, labels) ||
    !Equal.equals(expected.driverOpts ?? {}, info.Options ?? {})
  ) {
    return false;
  }
  const createdAt = Date.parse(info.CreatedAt);
  // A malformed timestamp cannot serve as independent identity evidence.
  if (!Number.isFinite(createdAt)) return false;
  if (expected.createdAtRaw && expected.createdAtRaw !== info.CreatedAt) return false;
  if (expected.createdAt > 0 && expected.createdAt !== createdAt) {
    return false;
  }
  const generation = expected.labels?.[VOLUME_INSTANCE_LABEL];
  if (generation !== undefined)
    return generation.length > 0 && generation === labels[VOLUME_INSTANCE_LABEL];
  // Without a generation label, a timestamp fabricated by an old version
  // (or truncated/invalid in Docker) is not evidence permitting deletion.
  return (
    (expected.createdAtRaw !== undefined &&
      Number.isFinite(Date.parse(expected.createdAtRaw)) &&
      expected.createdAtRaw === info.CreatedAt) ||
    (expected.createdAt > 0 && Number.isFinite(createdAt) && expected.createdAt === createdAt)
  );
};

export const toVolumeAttributes = (info: Docker.Volume): Volume["Attributes"] => ({
  id: info.Name,
  name: info.Name,
  driver: info.Driver,
  driverOpts: info.Options ?? {},
  labels: info.Labels ?? {},
  mountpoint: info.Mountpoint,
  createdAt: Number.isFinite(Date.parse(info.CreatedAt)) ? Date.parse(info.CreatedAt) : 0,
  createdAtRaw: info.CreatedAt,
});
