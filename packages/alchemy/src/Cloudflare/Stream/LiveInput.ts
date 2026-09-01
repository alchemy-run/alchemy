import * as stream from "@distilled.cloud/cloudflare/stream";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Stream.LiveInput" as const;
type TypeId = typeof TypeId;

/**
 * Recording behavior of a live input.
 */
export type LiveInputRecording = {
  /**
   * Origins allowed to display videos created from this live input.
   * Enter allowed origin domains in an array, e.g. `["example.com"]`.
   */
  allowedOrigins?: string[];
  /**
   * Disables reporting the number of live viewers when this is set to
   * `true`.
   * @default false
   */
  hideLiveViewerCount?: boolean;
  /**
   * Specifies the recording behavior for the live input. `off` prevents
   * the input from being recorded; `automatic` records the input as a
   * Cloudflare Stream video whenever a stream is live.
   * @default "off"
   */
  mode?: "off" | "automatic";
  /**
   * Indicates if signed URL tokens are required to view the recorded
   * video.
   * @default false
   */
  requireSignedURLs?: boolean;
  /**
   * Number of seconds the live input is considered live after the
   * broadcast stops, before the recording transitions to on-demand.
   * @default 0
   */
  timeoutSeconds?: number;
};

/**
 * An RTMPS ingest or playback endpoint of a live input.
 */
export type LiveInputRtmpsEndpoint = {
  /**
   * The RTMPS URL a broadcaster streams to (or a player pulls from).
   */
  url: string;
  /**
   * The secret stream key that authenticates against the URL.
   */
  streamKey: Redacted.Redacted<string>;
};

/**
 * An SRT ingest or playback endpoint of a live input.
 */
export type LiveInputSrtEndpoint = {
  /**
   * The SRT URL a broadcaster streams to (or a player pulls from).
   */
  url: string;
  /**
   * The stream id to send in the SRT handshake.
   */
  streamId: string;
  /**
   * The secret passphrase that authenticates against the URL.
   */
  passphrase: Redacted.Redacted<string>;
};

export type LiveInputProps = {
  /**
   * Sets the creator ID associated with this live input. Mutable.
   */
  defaultCreator?: string;
  /**
   * Number of days after which the live input's recordings are deleted.
   * The minimum accepted value is 30. Omit to retain recordings
   * indefinitely. Mutable.
   */
  deleteRecordingAfterDays?: number;
  /**
   * Whether the live input is enabled and can accept streams. Mutable.
   * @default true
   */
  enabled?: boolean;
  /**
   * A user modifiable key-value store used to reference other systems of
   * record for managing live inputs. By convention, set a `name` field
   * for display in the Cloudflare dashboard. If omitted, a `name`
   * derived from the app, stage, and logical ID is used. Mutable.
   * @default { name: ${app}-${stage}-${id} }
   */
  meta?: Record<string, unknown>;
  /**
   * Records the input to a Cloudflare Stream video when set to
   * `automatic` mode. Mutable.
   * @default { mode: "off" }
   */
  recording?: LiveInputRecording;
};

export type LiveInputAttributes = {
  /**
   * The unique identifier for the live input (Cloudflare `uid`).
   */
  liveInputId: string;
  /**
   * The Cloudflare account the live input belongs to.
   */
  accountId: string;
  /**
   * The date and time the live input was created.
   */
  created: string | undefined;
  /**
   * The date and time the live input was last modified.
   */
  modified: string | undefined;
  /**
   * Whether the live input is enabled and can accept streams.
   */
  enabled: boolean;
  /**
   * Number of days after which the live input's recordings are deleted,
   * if configured.
   */
  deleteRecordingAfterDays: number | undefined;
  /**
   * The user-modifiable key-value store associated with the live input.
   */
  meta: Record<string, unknown>;
  /**
   * The WHIP endpoint a broadcaster publishes WebRTC video to
   * (`https://customer-<code>.cloudflarestream.com/<secret>/webRTC/publish`).
   *
   * Redacted — the URL embeds a secret that grants publish access to this
   * input, so it must only be handed to authorized broadcasters. Unwrap
   * with `Redacted.value` server-side.
   *
   * `undefined` when the live input was hydrated from `list()`, which does
   * not return endpoint details.
   */
  webRTCUrl: Redacted.Redacted<string> | undefined;
  /**
   * The WHEP endpoint viewers play WebRTC video from
   * (`https://customer-<code>.cloudflarestream.com/<uid>/webRTC/play`).
   *
   * Safe to share publicly — it is keyed by the live input's uid and
   * supports unlimited concurrent viewers.
   *
   * `undefined` when the live input was hydrated from `list()`.
   */
  webRTCPlaybackUrl: string | undefined;
  /**
   * The RTMPS ingest endpoint, or `undefined` when hydrated from `list()`.
   */
  rtmps: LiveInputRtmpsEndpoint | undefined;
  /**
   * The RTMPS playback endpoint, or `undefined` when hydrated from `list()`.
   */
  rtmpsPlayback: LiveInputRtmpsEndpoint | undefined;
  /**
   * The SRT ingest endpoint, or `undefined` when hydrated from `list()`.
   */
  srt: LiveInputSrtEndpoint | undefined;
  /**
   * The SRT playback endpoint, or `undefined` when hydrated from `list()`.
   */
  srtPlayback: LiveInputSrtEndpoint | undefined;
};

export type LiveInput = Resource<
  TypeId,
  LiveInputProps,
  LiveInputAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Stream live input — an ingest endpoint (RTMPS/SRT/WebRTC)
 * that accepts live video and optionally records it as a Stream video.
 *
 * Live inputs are identified by an auto-assigned `uid`; every prop is
 * mutable in place via Cloudflare's PUT endpoint, so the resource is
 * never replaced. Deleting a live input does not delete videos already
 * recorded from it.
 *
 * Requires the Stream subscription to be enabled on the account.
 * ### Creating a live input
 * **Example:** Basic live input
 * ```typescript
 * const input = yield* Cloudflare.Stream.LiveInput("Broadcast", {});
 * ```
 *
 * **Example:** Live input with automatic recording
 * ```typescript
 * const input = yield* Cloudflare.Stream.LiveInput("Broadcast", {
 *   meta: { name: "town-hall" },
 *   recording: {
 *     mode: "automatic",
 *     timeoutSeconds: 10,
 *   },
 *   deleteRecordingAfterDays: 30,
 * });
 * ```
 *
 * ### Streaming over WebRTC (WHIP/WHEP)
 * Every live input exposes sub-second-latency WebRTC endpoints alongside
 * RTMPS and SRT — no extra configuration. `webRTCUrl` is the WHIP endpoint
 * a broadcaster publishes to; `webRTCPlaybackUrl` is the WHEP endpoint
 * viewers play from.
 *
 * **Example:** Hand the WHIP/WHEP endpoints to a browser client
 * ```typescript
 * const input = yield* Cloudflare.Stream.LiveInput("Broadcast", {});
 *
 * // WHIP publish URL — embeds a publish secret, so keep it server-side and
 * // only hand it to authorized broadcasters.
 * const whip = Redacted.value(input.webRTCUrl!);
 * // WHEP playback URL — safe to hand to any viewer.
 * const whep = input.webRTCPlaybackUrl;
 * ```
 *
 * **Example:** Publish from the browser with Cloudflare's WHIP client
 * ```typescript
 * // npm i @cloudflare/webrtc-client
 * import { WHIPClient } from "@cloudflare/webrtc-client";
 *
 * const media = await navigator.mediaDevices.getUserMedia({
 *   video: true,
 *   audio: true,
 * });
 * // `whipUrl` fetched from your Worker, which unwraps `input.webRTCUrl`.
 * const client = new WHIPClient(whipUrl, media);
 * ```
 *
 * ### Streaming over RTMPS or SRT
 * **Example:** Read the RTMPS ingest URL and stream key
 * ```typescript
 * const input = yield* Cloudflare.Stream.LiveInput("Broadcast", {});
 *
 * const url = input.rtmps!.url;
 * const streamKey = Redacted.value(input.rtmps!.streamKey);
 * ```
 *
 * ### Managing a live input
 * **Example:** Disable ingest without deleting the input
 * ```typescript
 * const input = yield* Cloudflare.Stream.LiveInput("Broadcast", {
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/stream/stream-live/
 * @see https://developers.cloudflare.com/stream/webrtc-beta/
 *
 * @resource
 * @product Stream
 * @category Media
 */
export const LiveInput = Resource<LiveInput>(TypeId);

/**
 * Returns true if the given value is a LiveInput resource.
 */
export const isLiveInput = (value: unknown): value is LiveInput =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const LiveInputProvider = () =>
  Provider.succeed(LiveInput, {
    stables: ["liveInputId", "accountId", "created"],

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // Everything else is mutable via PUT.
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // Live inputs have no deterministic name or tags, so a cold read
      // (state lost before the uid was persisted) cannot recover the
      // resource — rely on the cached uid.
      if (output?.liveInputId === undefined) return undefined;
      const accountId = output.accountId;
      const observed = yield* getLiveInput(accountId, output.liveInputId);
      return observed ? toAttributes(observed, accountId) : undefined;
    }),

    // Account collection: enumerate every live input in the account. The
    // Cloudflare list endpoint returns all inputs in a single response
    // (no cursor), so there is no extra pagination to drive. Hydrate each
    // item into the same Attributes shape `read` produces.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Cloudflare returns this list either wrapped (`{ liveInputs: [...] }`)
      // or as a bare `result` array depending on the account — handle both.
      const response = yield* stream.listLiveInputs({ accountId });
      const inputs = Array.isArray(response)
        ? response
        : (response.liveInputs ?? []);
      return inputs
        .filter(
          (li): li is typeof li & { uid: string } =>
            li.uid !== null && li.uid !== undefined,
        )
        .map((li) => toAttributes(li, accountId));
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const meta = news.meta ?? {
        name: yield* createPhysicalName({ id, lowercase: true }),
      };

      // Observe — the uid cached on `output` is a hint, not a guarantee:
      // a not-found falls through to "missing" and we recreate.
      const observed = output?.liveInputId
        ? yield* getLiveInput(output.accountId ?? accountId, output.liveInputId)
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the
        // full desired body. uids are auto-assigned so there is no
        // AlreadyExists race to tolerate.
        const created = yield* stream.createLiveInput({
          accountId,
          defaultCreator: news.defaultCreator,
          deleteRecordingAfterDays: news.deleteRecordingAfterDays,
          enabled: news.enabled,
          meta,
          recording: news.recording,
        });
        return toAttributes(created, accountId);
      }

      // Sync — diff observed cloud state against desired. The update API
      // is a PUT, so send the full desired body, but skip the call
      // entirely on a no-op. `defaultCreator` and `recording` are not
      // echoed by the API, so `olds` is the best available baseline for
      // them.
      const observedAccount = output?.accountId ?? accountId;
      const dirty =
        (news.enabled ?? true) !== (observed.enabled ?? true) ||
        (news.deleteRecordingAfterDays ?? undefined) !==
          (observed.deleteRecordingAfterDays ?? undefined) ||
        !deepValueEquals(meta, observed.meta ?? {}) ||
        news.defaultCreator !== olds?.defaultCreator ||
        !deepValueEquals(news.recording ?? {}, olds?.recording ?? {});

      if (!dirty) {
        return toAttributes(observed, observedAccount);
      }

      const updated = yield* stream.updateLiveInput({
        accountId: observedAccount,
        liveInputIdentifier: observed.uid ?? output!.liveInputId,
        defaultCreator: news.defaultCreator,
        deleteRecordingAfterDays: news.deleteRecordingAfterDays,
        enabled: news.enabled,
        meta,
        recording: news.recording,
      });
      return toAttributes(updated, observedAccount);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent — a live input already deleted out-of-band surfaces
      // as `LiveInputNotFound` (Cloudflare error code 10003).
      yield* stream
        .deleteLiveInput({
          accountId: output.accountId,
          liveInputIdentifier: output.liveInputId,
        })
        .pipe(Effect.catchTag("LiveInputNotFound", () => Effect.void));
    }),
  });

/**
 * Read a live input by uid, mapping "gone" (`LiveInputNotFound`,
 * Cloudflare error code 10003) to `undefined`.
 */
const getLiveInput = (accountId: string, liveInputId: string) =>
  stream
    .getLiveInput({ accountId, liveInputIdentifier: liveInputId })
    .pipe(
      Effect.catchTag("LiveInputNotFound", () => Effect.succeed(undefined)),
    );

const toAttributes = (
  input:
    | stream.GetLiveInputResponse
    | stream.CreateLiveInputResponse
    | stream.UpdateLiveInputResponse,
  accountId: string,
): LiveInputAttributes => ({
  liveInputId: input.uid ?? "",
  accountId,
  created: input.created ?? undefined,
  modified: input.modified ?? undefined,
  enabled: input.enabled ?? true,
  deleteRecordingAfterDays: input.deleteRecordingAfterDays ?? undefined,
  meta: (input.meta ?? {}) as Record<string, unknown>,
  // Endpoint details are only returned by create/get/update. The list
  // endpoint omits them, so a live input hydrated by `list()` carries
  // `undefined` here rather than a fabricated URL.
  webRTCUrl: input.webRTC?.url ? Redacted.make(input.webRTC.url) : undefined,
  webRTCPlaybackUrl: input.webRTCPlayback?.url ?? undefined,
  rtmps: toRtmpsEndpoint(input.rtmps),
  rtmpsPlayback: toRtmpsEndpoint(input.rtmpsPlayback),
  srt: toSrtEndpoint(input.srt),
  srtPlayback: toSrtEndpoint(input.srtPlayback),
});

const toRtmpsEndpoint = (
  endpoint:
    | { url?: string | null; streamKey?: string | null }
    | null
    | undefined,
): LiveInputRtmpsEndpoint | undefined =>
  endpoint?.url
    ? { url: endpoint.url, streamKey: Redacted.make(endpoint.streamKey ?? "") }
    : undefined;

const toSrtEndpoint = (
  endpoint:
    | {
        url?: string | null;
        streamId?: string | null;
        passphrase?: string | null;
      }
    | null
    | undefined,
): LiveInputSrtEndpoint | undefined =>
  endpoint?.url
    ? {
        url: endpoint.url,
        streamId: endpoint.streamId ?? "",
        passphrase: Redacted.make(endpoint.passphrase ?? ""),
      }
    : undefined;

/**
 * Structural equality for plain-JSON values (`meta`, `recording`) —
 * primitives, arrays, and plain objects, `null`-tolerant and key-order
 * insensitive.
 */
const deepValueEquals = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepValueEquals(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepValueEquals(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  }
  return false;
};
