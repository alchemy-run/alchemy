import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

export const exampleRoot = Effect.fn(function* (slug: string) {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(
    new URL(`../../../../../examples/neon-website-${slug}/`, import.meta.url),
  );
});

export const bodyContaining = Effect.fn(function* (url: string, text: string) {
  const body = yield* HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 8,
      until: (body) => body.includes(text),
    }),
  );
  expect(body).toContain(text);
  return body;
});
