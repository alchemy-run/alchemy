import * as Nextjs from "@alchemy.run/frontend-frameworks/nextjs/neon";
import * as Vocs from "@alchemy.run/frontend-frameworks/vocs/neon";
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

export const buildPortableExample = Effect.fn(function* (
  slug: "nextjs" | "vocs",
) {
  const path = yield* Path.Path;
  const root = yield* exampleRoot(slug);
  const target = slug === "nextjs" ? Nextjs.target() : Vocs.target();
  const output = yield* target.build({ root, framework: slug });
  expect(output.distDirectory).toBeDefined();
  expect(output.serverModules?.[0]).toBeDefined();
  return {
    root,
    distDir: output.distDirectory!,
    serverEntry: path.join(
      output.distDirectory!,
      output.serverModules![0]!.name,
    ),
    layout: slug === "nextjs" ? ("next" as const) : ("output" as const),
  };
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
