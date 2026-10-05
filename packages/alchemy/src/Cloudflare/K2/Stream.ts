import * as k2 from "@distilled.cloud/cloudflare/k2";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const StreamTypeId = "Cloudflare.K2.Stream" as const;
type StreamTypeId = typeof StreamTypeId;

/** K2's default retention: seven days. */
const DEFAULT_RETENTION_SECONDS = 604_800;

/**
 * HTTP input configuration of a K2 stream.
 */
export interface StreamHttpInput {
  /**
   * Require an API token with the `K2 Produce` permission on `/produce`.
   * When `false` the endpoint is public.
   * @default true
   */
  authentication?: boolean;
  /**
   * Origins allowed to produce from a browser: `http(s)://host[:port]`
   * without a path, or `*` alone. Up to five.
   */
  cors?: string[];
}

export interface StreamProps {
  /**
   * Name of the stream: 1 to 128 letters, numbers, or underscores, unique in
   * the account (not case-sensitive). If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing the name replaces the
   * stream.
   * @default ${app}_${id}_${stage}_${suffix}
   */
  name?: string;
  /**
   * How long records are retained, from one hour to 30 days. Rounded to whole
   * seconds. Mutable in place.
   * @default "7 days"
   */
  retention?: Duration.Input;
  /**
   * The stream's HTTP input (`POST https://<id>.k2.cloudflarestorage.com/produce`).
   * `false` disables it, `true` enables it with token authentication, and an
   * object enables it with the given settings. Mutable in place.
   * @default false
   */
  http?: boolean | StreamHttpInput;
  /**
   * Whether Workers can produce to the stream through a `k2` binding
   * (`Cloudflare.K2.WriteStream` with `WriteStreamBinding`). Mutable in place.
   * At least one of `http` and `workerBinding` must be enabled.
   * @default true
   */
  workerBinding?: boolean;
}

export interface StreamAttributes {
  /** The stream ID: 32 lowercase hexadecimal characters. */
  streamId: string;
  /** The stream name (unique in the account). */
  streamName: string;
  /** The stream's HTTP endpoint, `https://<id>.k2.cloudflarestorage.com`. */
  endpoint: string;
  /** How long records are retained, in seconds. */
  retentionSeconds: number;
  /** Whether the HTTP input accepts records. */
  httpEnabled: boolean;
  /** Whether the HTTP input requires a `K2 Produce` API token. */
  httpAuthentication: boolean;
  /** Origins allowed to produce from a browser. */
  corsOrigins: string[] | undefined;
  /** Whether Workers can produce through a `k2` binding. */
  workerBindingEnabled: boolean;
  /** Account that owns the stream. */
  accountId: string;
  /** When the stream was created. */
  createdAt: string;
  /** When the stream was last modified. */
  modifiedAt: string;
}

export type Stream = Resource<StreamTypeId, StreamProps, StreamAttributes, never, Providers>;

/**
 * A Cloudflare K2 stream — a durable, ordered log of records. Producers
 * append records over HTTP or from Workers through a `k2` binding;
 * consumers read them through a {@link Subscription}, each with its own
 * position in the stream.
 *
 * The name is fixed at creation (changing it replaces the stream);
 * retention and the HTTP / Worker-binding inputs are mutable in place.
 * ### Creating a Stream
 * **Example:** Stream with default settings
 * ```typescript
 * // Worker-binding input enabled, HTTP input disabled, 7-day retention.
 * const orders = yield* Cloudflare.K2.Stream("Orders");
 * ```
 *
 * **Example:** Custom retention
 * ```typescript
 * const orders = yield* Cloudflare.K2.Stream("Orders", {
 *   retention: "30 days",
 * });
 * ```
 *
 * ### HTTP Input
 * **Example:** Authenticated HTTP input
 * ```typescript
 * // POST records to orders.endpoint + "/produce" with a K2 Produce token.
 * const orders = yield* Cloudflare.K2.Stream("Orders", {
 *   http: true,
 * });
 * ```
 *
 * **Example:** Public HTTP input for browsers
 * ```typescript
 * const clicks = yield* Cloudflare.K2.Stream("Clicks", {
 *   http: { authentication: false, cors: ["https://app.example.com"] },
 *   workerBinding: false,
 * });
 * ```
 *
 * ### Producing from a Worker
 * **Example:** Send records through the Worker binding
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const orders = yield* Cloudflare.K2.WriteStream(Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders.send([{ content: JSON.stringify({ id: 1 }) }]);
 *         return HttpServerResponse.empty({ status: 202 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.K2.WriteStreamBinding)),
 * );
 * ```
 *
 * ### Consuming
 * **Example:** A subscription reading from the start of the stream
 * ```typescript
 * const analytics = yield* Cloudflare.K2.Subscription("Analytics", {
 *   streamId: orders.streamId,
 *   startAt: "earliest",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/k2/
 *
 * @resource
 * @product K2
 * @category Storage & Databases
 */
export const Stream = Resource<Stream>(StreamTypeId);

/** Returns true if the given value is a K2 Stream resource. */
export const isStream = (value: unknown): value is Stream =>
  Predicate.hasProperty(value, "Type") && value.Type === StreamTypeId;

export const StreamProvider = () =>
  Provider.succeed(Stream, {
    stables: ["streamId", "streamName", "endpoint", "accountId", "createdAt"],

    diff: Effect.fn(function* ({ id, olds, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // A generated name is engine-owned: the deployed name stays
      // authoritative. Only a different explicit name forces a replace.
      const oldName = output?.streamName ?? (yield* streamName(id, olds?.name));
      const newName = news.name ?? oldName;
      if (newName.toLowerCase() !== oldName.toLowerCase()) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.streamId) {
        const observed = yield* getStream(acct, output.streamId);
        if (observed) return toAttributes(observed, acct);
      }
      // Cold read: names are unique per account. A generated name embeds the
      // instance id (proof of ownership); an explicit name does not, so gate
      // takeover behind the adopt policy.
      const name = yield* streamName(id, olds?.name);
      const match = yield* findStreamByName(acct, name);
      if (match) {
        const attrs = toAttributes(match, acct);
        return olds?.name !== undefined ? Unowned(attrs) : attrs;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const name = output?.streamName ?? (yield* streamName(id, news.name));
      const desired = desiredState(news);

      // Observe — the cached id is a hint; fall back to the name.
      let observed = output?.streamId ? yield* getStream(acct, output.streamId) : undefined;
      if (!observed) {
        observed = yield* findStreamByName(acct, name);
      }

      // Ensure — create when missing. A taken name is a race or a lost state
      // write: adopt the stream with that name.
      if (!observed) {
        observed = yield* k2
          .createStream({
            accountId: acct,
            name,
            retentionSeconds: desired.retentionSeconds,
            http: desired.http,
            workerBinding: desired.workerBinding,
          })
          .pipe(
            Effect.catchTag("K2NameAlreadyExists", (error) =>
              findStreamByName(acct, name).pipe(
                Effect.flatMap((match) => (match ? Effect.succeed(match) : Effect.fail(error))),
              ),
            ),
          );
      }

      // Sync — diff observed cloud state against desired and PATCH only the
      // delta. A provided input object replaces the existing one.
      const patch: k2.UpdateStreamRequest = { accountId: acct, streamId: observed.id };
      let dirty = false;
      if (observed.retentionSeconds !== desired.retentionSeconds) {
        patch.retentionSeconds = desired.retentionSeconds;
        dirty = true;
      }
      if (!sameHttp(desired.http, observed.http)) {
        // An omitted `cors` keeps the existing origins; clear them explicitly.
        patch.http =
          desired.http.enabled && !desired.http.cors && observed.http.cors?.origins?.length
            ? { ...desired.http, cors: { origins: [] } }
            : desired.http;
        dirty = true;
      }
      if (observed.workerBinding.enabled !== desired.workerBinding.enabled) {
        patch.workerBinding = desired.workerBinding;
        dirty = true;
      }
      if (dirty) {
        observed = yield* k2.updateStream(patch);
      }

      return toAttributes(observed, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deleting a stream that does not exist succeeds.
      yield* k2.deleteStream({ accountId: output.accountId, streamId: output.streamId });
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* k2.listStreams.items({ accountId }).pipe(
        EffectStream.runCollect,
        Effect.map((chunk) => Array.from(chunk).map((s) => toAttributes(s, accountId))),
      );
    }),
  });

/** The stream state shared by the get/list/create/update responses. */
interface ObservedStream {
  id: string;
  name: string;
  retentionSeconds: number;
  endpoint: string;
  http: k2.StreamHttpInput;
  workerBinding: k2.StreamWorkerBindingInput;
  createdAt: string;
  modifiedAt: string;
}

/**
 * Stream names allow letters, numbers, and underscores only, so swap the
 * default hyphen delimiter for underscores.
 */
const streamName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    const generated = yield* createPhysicalName({
      id,
      lowercase: true,
      delimiter: "_",
      maxLength: 128,
    });
    return generated.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  });

const getStream = (accountId: string, streamId: string) =>
  k2.getStream({ accountId, streamId }).pipe(
    Effect.map((s): ObservedStream | undefined => s),
    Effect.catchTag("K2StreamNotFound", () => Effect.succeed(undefined)),
  );

/** Names are unique per account and not case-sensitive. */
const findStreamByName = (accountId: string, name: string) =>
  k2.listStreams.items({ accountId }).pipe(
    EffectStream.filter((s) => s.name.toLowerCase() === name.toLowerCase()),
    EffectStream.runHead,
    Effect.map((match): ObservedStream | undefined => Option.getOrUndefined(match)),
  );

const desiredState = (props: StreamProps) => {
  const http: k2.StreamHttpInput =
    props.http === undefined || props.http === false
      ? { enabled: false }
      : props.http === true
        ? { enabled: true, authentication: true }
        : {
            enabled: true,
            authentication: props.http.authentication ?? true,
            ...(props.http.cors ? { cors: { origins: props.http.cors } } : {}),
          };
  return {
    retentionSeconds: toWireSeconds(props.retention) ?? DEFAULT_RETENTION_SECONDS,
    http,
    workerBinding: { enabled: props.workerBinding ?? true },
  };
};

const sameHttp = (desired: k2.StreamHttpInput, observed: k2.StreamHttpInput) => {
  if (!desired.enabled && !observed.enabled) return true;
  if (desired.enabled !== observed.enabled) return false;
  if ((desired.authentication ?? false) !== (observed.authentication ?? false)) return false;
  const want = [...(desired.cors?.origins ?? [])].sort().join(",");
  const have = [...(observed.cors?.origins ?? [])].sort().join(",");
  return want === have;
};

const toAttributes = (observed: ObservedStream, accountId: string): StreamAttributes => ({
  streamId: observed.id,
  streamName: observed.name,
  endpoint: observed.endpoint,
  retentionSeconds: observed.retentionSeconds,
  httpEnabled: observed.http.enabled,
  httpAuthentication: observed.http.authentication ?? false,
  corsOrigins: observed.http.cors?.origins ? [...observed.http.cors.origins] : undefined,
  workerBindingEnabled: observed.workerBinding.enabled,
  accountId,
  createdAt: observed.createdAt,
  modifiedAt: observed.modifiedAt,
});
