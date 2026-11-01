import { expect } from "@alchemy.run/test";
import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT AI Model Serving suites.
 *
 * A token costs nothing and inference is billed per token: at price list v1.0.44, EUR 0.15 and
 * EUR 0.25 per million input and output tokens on a standard chat model, and EUR 0.02 per million
 * on a standard embedding model. A full run sends about a dozen short prompts of at most 32 output
 * tokens: under EUR 0.01. So the suites run ungated.
 */

/** The token, or `"gone"` on the typed not-found or once it is deleting. */
export const observeToken = (projectId: string, region: string, tId: string) =>
  modelServing.getToken({ projectId, regionId: region, tId }).pipe(
    Effect.map(({ token }) => (token.state === "deleting" ? ("gone" as const) : token)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Bounded wait (about 2 minutes) until a read reports `"gone"`, then assert it. */
export const expectGone = <A, E, R>(read: Effect.Effect<A | "gone", E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (value) => value === "gone",
      times: 24,
    }),
    Effect.tap((value) => Effect.sync(() => expect(value).toEqual("gone"))),
  );
