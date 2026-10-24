import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { LogLine } from "alchemy/Provider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";

/**
 * Stream new events from a CloudWatch log group as {@link LogLine}s.
 *
 * Uses a `StartLiveTail` session. Endpoints that reject the operation as
 * `UnsupportedOperation` (the floci emulator behind `alchemy dev`) fall back
 * to polling `FilterLogEvents`. Other failures restart the session.
 */
export const tailLogGroup = (logGroupName: string) =>
  liveTail(logGroupName).pipe(
    Stream.catchTag("UnsupportedOperation", () => pollLogGroup(logGroupName)),
    Stream.retry(Schedule.spaced("1 second")),
  );

const liveTail = (logGroupName: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const response = yield* logs.startLiveTail({
        logGroupIdentifiers: [`arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`],
      });
      if (!response.responseStream) {
        return Stream.empty as Stream.Stream<LogLine>;
      }
      return response.responseStream.pipe(
        Stream.flatMap((event) =>
          "sessionUpdate" in event && event.sessionUpdate
            ? Stream.fromIterable(
                (event.sessionUpdate.sessionResults ?? []).flatMap((result): LogLine[] =>
                  result.message
                    ? [
                        {
                          timestamp: new Date(result.timestamp ?? Date.now()),
                          message: result.message.trimEnd(),
                        },
                      ]
                    : [],
                ),
              )
            : Stream.empty,
        ),
      );
    }),
  );

/**
 * Poll `FilterLogEvents` once a second for events at or after a cursor.
 * `startTime` is inclusive, so events at the cursor's millisecond are
 * remembered by id and skipped on the next poll.
 */
const pollLogGroup = (logGroupName: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const cursor = yield* Ref.make({
        startTime: yield* Clock.currentTimeMillis,
        seen: new Set<string>(),
      });
      const poll = Effect.gen(function* () {
        const { startTime, seen } = yield* Ref.get(cursor);
        const events = yield* logs.filterLogEvents.pages({ logGroupName, startTime }).pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.events ?? [])),
          Stream.runCollect,
          Effect.catchTag("ResourceNotFoundException", () => Effect.succeed([])),
        );
        const fresh = events.filter(
          (event) => event.eventId === undefined || !seen.has(event.eventId),
        );
        const latest = Math.max(startTime, ...events.map((event) => event.timestamp ?? 0));
        yield* Ref.set(cursor, {
          startTime: latest,
          seen: new Set(
            events.flatMap((event) =>
              event.timestamp === latest && event.eventId !== undefined ? [event.eventId] : [],
            ),
          ),
        });
        return fresh
          .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
          .flatMap((event): LogLine[] =>
            event.message
              ? [
                  {
                    timestamp: new Date(event.timestamp ?? Date.now()),
                    message: event.message.trimEnd(),
                  },
                ]
              : [],
          );
      });
      return Stream.fromEffect(poll).pipe(
        Stream.repeat(Schedule.spaced("1 second")),
        Stream.flatMap(Stream.fromIterable),
      );
    }),
  );
