/**
 * How Archil bindings reach Archil from any host.
 *
 * Archil only mints API keys from a console session and can't scope them,
 * so a host's control-plane clients use the key the stack deploys with,
 * recorded per host and read back at run time. Hosts that only touch one
 * disk never hold an API key: the object bindings get a per-host S3
 * `Archil.DiskUser` (read-only for `ReadDisk`), and `MountDisk` a per-host
 * token user.
 */
import { controlPlaneUrl, Credentials, DEFAULT_REGION } from "@distilled.cloud/archil/Credentials";
import * as Objects from "@distilled.cloud/archil/Objects";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Disk } from "./Disk.ts";
import { DiskUser } from "./DiskUser.ts";
import { DeployerKey } from "./internal/DeployerKey.ts";

/** Runs disk object effects and streams with one set of object credentials. */
export interface ObjectsRunner {
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E,
    Exclude<R, Objects.ObjectCredentials | HttpClient.HttpClient> | RuntimeContext
  >;
  stream<A, E, R>(
    stream: Stream.Stream<A, E, R>,
  ): Stream.Stream<
    A,
    E,
    Exclude<R, Objects.ObjectCredentials | HttpClient.HttpClient> | RuntimeContext
  >;
}

/** Runs Archil SDK effects and streams with the host's own API key. */
export interface Authorize {
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, Credentials | HttpClient.HttpClient> | RuntimeContext>;
  stream<A, E, R>(
    stream: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E, Exclude<R, Credentials | HttpClient.HttpClient> | RuntimeContext>;
  /** Disk object calls with the same API key. */
  readonly objects: ObjectsRunner;
}

// TypeScript can't infer a generic call signature whose requirement is
// `Exclude<R, …>` from `Effect.provide`, so runners assert their shape.
const runnerOf = <Rm>(layer: Layer.Layer<Rm>) => ({
  run: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer)),
  stream: <A, E, R>(stream: Stream.Stream<A, E, R>) => stream.pipe(Stream.provide(layer)),
});

/**
 * Record (at deploy) and read back (at run time) the API key a host's
 * Archil clients call the control plane with. Every Archil binding on one
 * host shares one record (the engine de-duplicates the declaration).
 */
export const ApiAccess = Effect.gen(function* () {
  const Key = yield* DeployerKey;
  return Effect.fn(function* () {
    const host = yield* Binding.Host;
    const token = yield* Key(`${host?.LogicalId ?? "Script"}ArchilApiKey`, {});
    const apiKey = yield* token.apiKey;
    const region = yield* token.region;
    const credentials = Effect.all([apiKey, region]).pipe(
      Effect.map(([key, r]) => ({
        apiKey: key,
        apiBaseUrl: controlPlaneUrl(r) ?? controlPlaneUrl(DEFAULT_REGION)!,
        region: r,
      })),
    );
    const layer = Layer.mergeAll(Objects.ObjectCredentialsFromApiKey, FetchHttpClient.layer).pipe(
      Layer.provideMerge(Layer.succeed(Credentials, credentials)),
    );
    const { run, stream } = runnerOf(layer);
    const objects = Object.assign(run, { stream }) as unknown as ObjectsRunner;
    return Object.assign(run, { stream, objects }) as unknown as Authorize;
  });
});

/**
 * Create (at deploy) and read back (at run time) a per-host S3 user on one
 * disk, and run object calls signed with its keys. The keys reach only
 * that disk, and only `GET`/`HEAD` when `readOnly`. Every object binding
 * of one kind on one host shares one user (the engine de-duplicates the
 * declaration).
 */
export const DiskKeyAccess = Effect.gen(function* () {
  const Users = yield* DiskUser;
  return Effect.fn(function* (disk: Disk, access: "read" | "write") {
    const host = yield* Binding.Host;
    const user = yield* Users(
      `${host?.LogicalId ?? "Script"}${disk.LogicalId}${access === "read" ? "Reader" : "Writer"}`,
      { disk: disk.diskId, type: "s3", readOnly: access === "read" },
    );
    const accessKeyId = yield* user.accessKeyId;
    const secretAccessKey = yield* user.secretAccessKey;
    const region = yield* disk.region;
    const auth = Effect.gen(function* () {
      const keyId = yield* accessKeyId;
      const secret = yield* secretAccessKey;
      if (keyId === undefined || secret === undefined) {
        return yield* new ConfigError({
          message: `The S3 user for ${disk.LogicalId} has no keys; redeploy to create them again.`,
        });
      }
      return yield* Objects.diskKeysAuth({
        region: yield* region,
        accessKeyId: keyId,
        secretAccessKey: secret,
      });
    });
    const layer = Layer.mergeAll(
      Layer.succeed(Objects.ObjectCredentials, auth),
      FetchHttpClient.layer,
    );
    const { run, stream } = runnerOf(layer);
    return Object.assign(run, { stream }) as unknown as ObjectsRunner;
  });
});

/** What every name a run-time client creates starts with. */
export const RUNTIME_NAME_MARKER = "alc-";

const toNameLabel = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/** FNV-1a, 32-bit, as 8 hex digits: the same on every host, no crypto API needed. */
const fnv1a = (value: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * The owner a binding's run-time client stamps on what it creates. Archil
 * disks and sandboxes have no tags, labels or descriptions, only a name,
 * so the owner (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) is a
 * name prefix: `alc-<id>-<hash of stack/stage/id>`. Hosts know their stack
 * and stage at run time (`ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`), so the
 * prefix is the same at deploy and at run time without a resource.
 * Destroying the stack doesn't delete what carries it.
 */
export const runtimePrefix = Effect.fn(function* (label: string) {
  const host = yield* Binding.Host;
  const stack = yield* Effect.serviceOption(Stack);
  const tags = {
    "alchemy::stack": Option.isSome(stack) ? stack.value.name : "",
    "alchemy::stage": Option.isSome(stack) ? stack.value.stage : "",
    "alchemy::id": `${host?.LogicalId ?? "Script"}${label}`,
  };
  const owner = `${tags["alchemy::stack"]}/${tags["alchemy::stage"]}/${tags["alchemy::id"]}`;
  const readable = toNameLabel(tags["alchemy::id"]).slice(0, 14).replace(/-+$/, "") || "x";
  return {
    prefix: `${RUNTIME_NAME_MARKER}${readable}-${fnv1a(owner)}`,
    tags,
  };
});

/** `<prefix>-<name>`. */
export const runtimeName = (prefix: string, name: string) => `${prefix}-${name}`;
