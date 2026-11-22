import type * as Provider from "alchemy/Provider";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { RenderPollConfig, type RenderCredentials } from "../Credentials.ts";
import type { RenderApiError, RenderOwnerResolutionError } from "../Errors.ts";
import * as Client from "./Client.ts";

const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;
const INITIAL_TAIL_LOOKBACK_MS = 5_000;
const MAX_SEEN_LOG_IDS = 2_000;

const parseTimestamp = (value: string, fallbackMs: number): DateTime.Utc =>
  Option.getOrElse(DateTime.make(value), () => DateTime.makeUnsafe(fallbackMs));

/** Fetch historical log entries for a Render resource via `GET /v1/logs`. */
export const renderResourceLogs = (input: {
  readonly ownerId?: string;
  readonly resourceId: string;
  readonly options: Provider.LogsInput;
}): Effect.Effect<
  Provider.LogLine[],
  RenderApiError | RenderOwnerResolutionError,
  HttpClient.HttpClient | RenderCredentials
> =>
  Effect.gen(function* () {
    const ownerId = yield* Client.resolveOwnerId(input.ownerId);
    const now = yield* Clock.currentTimeMillis;
    const since = input.options.since
      ? DateTime.makeUnsafe(input.options.since)
      : DateTime.makeUnsafe(now - DEFAULT_LOOKBACK_MS);
    const res = yield* Client.listLogs({
      ownerId,
      resource: [input.resourceId],
      startTime: DateTime.formatIso(since),
      direction: "forward",
      limit: input.options.limit ?? 100,
    });
    return res.logs.map((entry): Provider.LogLine => ({
      timestamp: DateTime.toDateUtc(parseTimestamp(entry.timestamp, now)),
      message: entry.message,
    }));
  });

/** Stream live logs for a Render resource by polling `GET /v1/logs` with deduplication. */
export const renderResourceTail = (input: {
  readonly ownerId?: string;
  readonly resourceId: string;
}): Stream.Stream<
  Provider.LogLine,
  RenderApiError | RenderOwnerResolutionError,
  HttpClient.HttpClient | RenderCredentials
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pollOpt = yield* Effect.serviceOption(RenderPollConfig);
      const intervalMs = Option.isSome(pollOpt) ? Math.max(5, pollOpt.value.intervalMs) : 2_000;
      const ownerId = yield* Client.resolveOwnerId(input.ownerId);
      const initialNow = yield* Clock.currentTimeMillis;
      const seenIds = new Set<string>();
      let cursorIso = DateTime.formatIso(
        DateTime.makeUnsafe(initialNow - INITIAL_TAIL_LOOKBACK_MS),
      );

      const pollBatch = Effect.gen(function* () {
        const res = yield* Client.listLogs({
          ownerId,
          resource: [input.resourceId],
          startTime: cursorIso,
          direction: "forward",
          limit: 100,
        });
        const pollNow = yield* Clock.currentTimeMillis;
        const unseen: Provider.LogLine[] = [];
        let maxTsMs = Option.match(DateTime.make(cursorIso), {
          onNone: () => pollNow,
          onSome: DateTime.toEpochMillis,
        });
        for (const entry of res.logs) {
          if (seenIds.has(entry.id)) continue;
          seenIds.add(entry.id);
          if (seenIds.size > MAX_SEEN_LOG_IDS) {
            const oldest = seenIds.values().next().value;
            if (oldest !== undefined) seenIds.delete(oldest);
          }
          const ts = parseTimestamp(entry.timestamp, pollNow);
          const tsMs = DateTime.toEpochMillis(ts);
          if (tsMs >= maxTsMs) {
            maxTsMs = tsMs;
          }
          unseen.push({ timestamp: DateTime.toDateUtc(ts), message: entry.message });
        }
        if (unseen.length > 0) {
          cursorIso = DateTime.formatIso(DateTime.makeUnsafe(maxTsMs));
        }
        return unseen;
      });

      return Stream.fromEffect(pollBatch).pipe(
        Stream.repeat(Schedule.spaced(Duration.millis(intervalMs))),
        Stream.flatMap(Stream.fromIterable),
      );
    }),
  );
