import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const main = pathe.resolve(import.meta.dirname, "fixtures/prebuilt/worker.mjs");

// `dev: true` selects the local provider. A `bundle: false` Worker must be
// served byte-for-byte in local dev exactly like the deploy path: the entry
// plus its rule-matched siblings (nested ES modules AND the nested text
// module) are handed to workerd as-is.
//
// Regression: the local provider used to run every non-Python `main`
// through the rolldown watcher, re-bundling the prebuilt artifact. That
// broke the byte-for-byte contract outright — this fixture's `.txt` module
// import isn't even bundleable — so local dev of `bundle: false` workers
// failed while deploy worked. The prebuilt source now fs-watches and
// re-reads the module graph instead of bundling.
test.provider(
  "serves a prebuilt (bundle: false) Worker byte-for-byte from local workerd",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("PrebuiltLocalWorker", {
            main,
            bundle: false,
            compatibility: {
              date: "2024-01-01",
            },
          });
        }),
      );

      expect(worker.url).toBeDefined();
      // The response is assembled across both nested ES modules and the
      // nested text module — it can only be produced when the full module
      // graph reached workerd unbundled.
      yield* expectUrlContains(
        worker.url!,
        "prebuilt-modules-survived alchemy-prebuilt-notice-4d2a!",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 120_000,
  },
);

/**
 * A prebuilt entry written by the test, so it can be rewritten live. The
 * isolate's boot id is drawn on the first request (random values are not
 * allowed at module scope) and lives as long as the workerd serving it.
 */
const reloadDir = pathe.resolve(import.meta.dirname, "../../../.tmp/prebuilt-reload");
const reloadEntry = (marker: string) => `let boot;
export default {
  fetch() {
    boot ??= crypto.randomUUID();
    return Response.json({ marker: ${JSON.stringify(marker)}, boot });
  },
};
`;

const readBoot = Effect.fn(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(url);
  return (yield* response.json) as { marker: string; boot: string };
});

// #3214: every `fs.watch` event under the entry's directory used to re-read
// AND re-serve the bundle with a fresh workerd, even when nothing in it
// changed (macOS reports a late event for a just-created directory). Only a
// bundle whose hash differs may restart the Worker.
test.provider(
  "a watch event that leaves a prebuilt bundle unchanged does not restart workerd",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const entry = path.join(reloadDir, "worker.mjs");

      yield* stack.destroy();
      yield* fs.makeDirectory(reloadDir, { recursive: true });
      yield* fs.writeFileString(entry, reloadEntry("v1"));
      yield* fs.remove(path.join(reloadDir, "notes.md"), { force: true });

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("PrebuiltReloadWorker", {
            main: entry,
            bundle: false,
            compatibility: { date: "2024-01-01" },
          });
        }),
      );
      const url = worker.url!;
      const first = yield* readBoot(url).pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
      );
      expect(first.marker).toBe("v1");

      // Rewrite the entry byte-for-byte and add a file no module rule
      // picks up: both fire watch events, neither changes the bundle.
      for (let i = 0; i < 3; i++) {
        yield* fs.writeFileString(entry, reloadEntry("v1"));
        yield* fs.writeFileString(path.join(reloadDir, "notes.md"), `note ${i}\n`);
        yield* Effect.sleep("1 second");
      }
      // Well past the watcher's 200 ms debounce and a workerd restart.
      yield* Effect.sleep("5 seconds");
      expect(yield* readBoot(url)).toEqual(first);

      // A real change still restarts it with the new code.
      yield* fs.writeFileString(entry, reloadEntry("v2"));
      const second = yield* readBoot(url).pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (body) => body.marker === "v2",
          times: 30,
        }),
      );
      expect(second.marker).toBe("v2");
      expect(second.boot).not.toBe(first.boot);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);
