/**
 * #3233: under `alchemy dev`, a user-supplied container context that
 * CONTAINS `.alchemy` (`context: "."` at a project root) restarted its
 * container every ~20 s, because the run's own log and state writes changed
 * the context watcher's fingerprint.
 *
 * This file points the whole run's `.alchemy` (sidecar included) inside the
 * build context, so the dev run's real writes land there, then adds the
 * other writes no image sees: `.git` and a `.dockerignore`d directory. None
 * may restart the container; a real content change still must.
 *
 * Requires Docker.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import {
  IGNORED_WRITES_CONTEXT_DIR,
  IGNORED_WRITES_PORT,
} from "./fixtures/ignored-writes/container.ts";
import IgnoredWritesWorker from "./fixtures/ignored-writes/worker.ts";

const dotAlchemy = pathe.join(IGNORED_WRITES_CONTEXT_DIR, ".alchemy");

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true, dotAlchemy });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** Each container boot writes a fresh `/boot.txt`, so a restart is visible. */
const dockerfile = `FROM busybox:stable
COPY index.html /www/index.html
EXPOSE ${IGNORED_WRITES_PORT}
CMD ["sh", "-c", "cat /proc/sys/kernel/random/uuid > /www/boot.txt && exec httpd -f -p ${IGNORED_WRITES_PORT} -h /www"]
`;

const read = Effect.fn(function* (url: string, path: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(`${url}${path}`);
  return (yield* response.text).trim();
});

/** Poll until the file body matches. */
const pollText = Effect.fn(function* (url: string, path: string, expected: string) {
  const body = yield* read(url, path).pipe(
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (b): boolean => b === expected,
      times: 90,
    }),
  );
  expect(body).toBe(expected);
});

describe.sequential(
  "LocalContainerIgnoredWrites",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:container",
      "provider:cloudflare:worker",
      "local",
    ],
  },
  () => {
    test.provider(
      "writes the image never sees do not restart the container",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const file = (...segments: string[]) =>
            path.join(IGNORED_WRITES_CONTEXT_DIR, ...segments);

          yield* stack.destroy();

          yield* fs.makeDirectory(path.join(dotAlchemy, "logs"), { recursive: true });
          yield* fs.makeDirectory(file(".git"), { recursive: true });
          yield* fs.makeDirectory(file("ignored"), { recursive: true });
          yield* fs.writeFileString(file("Dockerfile"), dockerfile);
          yield* fs.writeFileString(file("index.html"), "v1\n");
          yield* fs.writeFileString(file(".dockerignore"), "ignored/\n");

          const { worker } = yield* stack.deploy(
            Effect.gen(function* () {
              return { worker: yield* IgnoredWritesWorker };
            }),
          );
          const url = worker.url!;
          yield* pollText(url, "/index.html", "v1");
          const boot = yield* read(url, "/boot.txt");
          expect(boot).toMatch(/^[0-9a-f-]{36}$/);

          for (let i = 0; i < 3; i++) {
            yield* fs.writeFileString(path.join(dotAlchemy, "logs", "dev.log"), `${i}\n`);
            yield* fs.writeFileString(file(".git", "index"), `${i}`);
            yield* fs.writeFileString(file("ignored", "a.txt"), `${i}`);
            yield* Effect.sleep("2 seconds");
          }
          // Well past the watcher's 500 ms debounce: still the same boot.
          yield* Effect.sleep("5 seconds");
          expect(yield* read(url, "/boot.txt")).toBe(boot);

          // The watcher is still live: a real change restarts the container.
          yield* fs.writeFileString(file("index.html"), "v2\n");
          yield* pollText(url, "/index.html", "v2");
          expect(yield* read(url, "/boot.txt")).not.toBe(boot);

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 600_000 },
    );
  },
);
