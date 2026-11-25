import * as MuxRetry from "@distilled.cloud/mux/Retry";
import * as Video from "@distilled.cloud/mux/video";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { redact } from "../internal/redact.ts";
import type { Providers } from "../Providers.ts";

export interface SimulcastTargetProps {
  /**
   * The Mux live stream to restream. Changing it replaces the target.
   */
  live_stream_id: string;
  /**
   * RTMP(S) ingest URL of the destination, such as
   * `rtmps://a.rtmp.youtube.com/live2`, or a full SRT connection string.
   * Changing it replaces the target.
   */
  url: string | Redacted.Redacted<string>;
  /**
   * The destination's stream key. Pass a `Redacted` value from a secret
   * store. Changing it replaces the target.
   */
  stream_key?: string | Redacted.Redacted<string>;
  /**
   * Your own identifier for the target, up to 255 characters. Changing it
   * replaces the target.
   */
  passthrough?: string;
}

export interface SimulcastTargetAttributes {
  /** Mux simulcast target ID. */
  id: string;
  /** The live stream this target restreams. */
  live_stream_id: string;
  /** Destination URL. Kept `Redacted` because an SRT URL carries its passphrase. */
  url: Redacted.Redacted<string>;
  /** Your identifier for the target. Omitted when empty. */
  passthrough?: string;
  /** `idle`, `starting`, `broadcasting` or `errored`. */
  status: Video.SimulcastTargetStatus;
  /** `fatal` when the destination rejected the stream, `normal` otherwise. */
  error_severity?: Video.SimulcastTargetErrorSeverity;
}

export type SimulcastTarget = Resource<
  "Mux.Video.SimulcastTarget",
  SimulcastTargetProps,
  SimulcastTargetAttributes,
  never,
  Providers
>;

/**
 * A Mux simulcast target: restreams a live stream to another RTMP or SRT
 * destination such as YouTube, Twitch or LinkedIn while Mux records and
 * serves it.
 * @see https://www.mux.com/docs/guides/stream-live-to-3rd-party-platforms
 *
 * Mux only accepts target changes while the stream is idle, and rejects
 * targets on `test: true` streams. The destination's stream key is sent to
 * Mux and never kept in the target's attributes.
 *
 * :::caution
 * Mux has no update endpoint for simulcast targets, so changing any prop
 * replaces the target. Replacing the live stream replaces its targets too.
 * When a stream is finishing an interrupted update, Alchemy hides even its
 * `id` from dependents, so that deploy also recreates its targets with the
 * same settings.
 * :::
 *
 * ### Creating a SimulcastTarget
 * **Example:** Restream to YouTube
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 * });
 * const youtube = yield* Mux.Video.SimulcastTarget("YouTube", {
 *   live_stream_id: stream.id,
 *   url: "rtmps://a.rtmp.youtube.com/live2",
 *   stream_key: Redacted.make(process.env.YOUTUBE_STREAM_KEY!),
 * });
 * ```
 *
 * **Example:** Restream to several platforms
 * ```typescript
 * const stream = yield* Mux.Video.LiveStream("MainStage", {
 *   playback_policies: ["public"],
 * });
 * yield* Mux.Video.SimulcastTarget("Twitch", {
 *   live_stream_id: stream.id,
 *   url: "rtmp://live.twitch.tv/app",
 *   stream_key: Redacted.make(process.env.TWITCH_STREAM_KEY!),
 *   passthrough: "twitch",
 * });
 * yield* Mux.Video.SimulcastTarget("LinkedIn", {
 *   live_stream_id: stream.id,
 *   url: "rtmps://live.linkedin.com:443/live",
 *   stream_key: Redacted.make(process.env.LINKEDIN_STREAM_KEY!),
 *   passthrough: "linkedin",
 * });
 * ```
 *
 * @resource
 */
export const SimulcastTarget = Resource<SimulcastTarget>("Mux.Video.SimulcastTarget");

/** Raised if the engine asks to change a target in place, which Mux cannot do. */
export class SimulcastTargetImmutable extends Data.TaggedError("SimulcastTargetImmutable")<{
  readonly id: string;
}> {
  override get message() {
    return `Simulcast target ${this.id} cannot be updated in place; it must be replaced.`;
  }
}

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const comparable = (props: SimulcastTargetProps | undefined) =>
  props && { ...props, url: reveal(props.url), stream_key: reveal(props.stream_key) };

const toAttrs = (
  target: Video.SimulcastTarget,
  live_stream_id: string,
): SimulcastTargetAttributes => ({
  id: target.id,
  live_stream_id,
  url: redact(target.url),
  passthrough: target.passthrough,
  status: target.status,
  error_severity: target.error_severity,
});

export const SimulcastTargetProvider = () =>
  Provider.effect(
    SimulcastTarget,
    Effect.gen(function* () {
      const create = yield* Video.createLiveStreamSimulcastTarget;
      const get = yield* Video.getLiveStreamSimulcastTarget;
      const del = yield* Video.deleteLiveStreamSimulcastTarget;
      const listStreams = yield* Video.listLiveStreams;

      const observe = (output: SimulcastTargetAttributes | undefined) =>
        output?.id === undefined
          ? Effect.undefined
          : get({ LIVE_STREAM_ID: output.live_stream_id, SIMULCAST_TARGET_ID: output.id }).pipe(
              Effect.map((res) => res.data),
              Effect.catchTag("NotFound", () => Effect.undefined),
            );

      return {
        stables: ["id", "live_stream_id"],
        list: () =>
          listStreams.items({ limit: 100 }).pipe(
            Stream.runCollect,
            Effect.map((streams) =>
              streams.flatMap((stream) =>
                (stream.simulcast_targets ?? []).map((target) => toAttrs(target, stream.id)),
              ),
            ),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          // Unresolved props mean an upstream value is changing (typically the
          // stream being replaced). Targets cannot be updated, so replace.
          if (!isResolved(news)) return { action: "replace" } as const;
          return deepEqual(comparable(olds), comparable(news))
            ? undefined
            : ({ action: "replace" } as const);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const observed = yield* observe(output);
          if (observed !== undefined) {
            const same =
              output?.live_stream_id === news.live_stream_id &&
              reveal(observed.url) === reveal(news.url) &&
              (observed.passthrough ?? "") === (news.passthrough ?? "");
            if (!same) return yield* new SimulcastTargetImmutable({ id: observed.id });
            return toAttrs(observed, news.live_stream_id);
          }
          // A create that failed with a 5xx may still have happened, so it
          // is retried only on throttling.
          const { data: created } = yield* create({
            LIVE_STREAM_ID: news.live_stream_id,
            url: news.url,
            stream_key: news.stream_key,
            passthrough: news.passthrough,
          }).pipe(MuxRetry.throttling);
          return toAttrs(created, news.live_stream_id);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({
            LIVE_STREAM_ID: output.live_stream_id,
            SIMULCAST_TARGET_ID: output.id,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const observed = yield* observe(output);
          return observed === undefined ? undefined : toAttrs(observed, output.live_stream_id);
        }),
      };
    }),
  );
