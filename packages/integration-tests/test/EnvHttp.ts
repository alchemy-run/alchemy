import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

export class NotReady extends Data.TaggedError("NotReady")<{ status: number; body?: string }> {
  override get message() {
    return `status ${this.status}${this.body === undefined ? "" : `: ${this.body}`}`;
  }
}

/**
 * GET `url` as JSON, retrying (bounded) while a freshly deployed host is not
 * serving 200s yet.
 */
export const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new NotReady({ status: 0 })),
    }),
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : res.text.pipe(
            Effect.flatMap((body) => Effect.fail(new NotReady({ status: res.status, body }))),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "NotReady",
      schedule: Schedule.spaced("3 seconds"),
      times: 20,
    }),
  );
