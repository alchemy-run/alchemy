/**
 * `assets.retainPrevious` against the real asset upload session.
 *
 * Deploy N serves build N plus build N-1's retained files, and never the
 * files deploy N-1 itself carried: a lazily loaded chunk of the previous
 * build survives exactly one deploy.
 */
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import { expectUrlAbsent, expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const marker = (build: number) => `assets-retain-previous-build-${build}`;

test.provider(
  "assets: retainPrevious serves the previous build's chunks for one deploy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const directory = yield* fs.makeTempDirectory({
        prefix: "alchemy-assets-retain-",
      });
      yield* fs.makeDirectory(path.join(directory, "assets"));
      yield* fs.writeFileString(
        path.join(directory, "index.html"),
        "<!doctype html><html><body>shell</body></html>",
      );
      const chunk = (build: number) =>
        path.join(directory, "assets", `chunk-${build}.js`);

      const deploy = (build: number) =>
        Effect.gen(function* () {
          if (build > 1) {
            yield* fs.remove(chunk(build - 1));
          }
          yield* fs.writeFileString(
            chunk(build),
            `export const build = "${marker(build)}";`,
          );
          return yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("AssetsRetainPreviousWorker", {
                workersDev: true,
                assets: {
                  directory,
                  retainPrevious: { paths: ["assets/**"] },
                },
              });
            }),
          );
        });

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        const first = yield* deploy(1);
        workerName = first.workerName;
        expect(Object.keys(first.retainedAssets ?? {})).toEqual([
          "/assets/chunk-1.js",
        ]);
        yield* expectUrlContains(`${first.url!}/assets/chunk-1.js`, marker(1), {
          timeout: "120 seconds",
          label: "build 1 chunk",
        });

        const second = yield* deploy(2);
        // Records its own build only, not the carried chunk.
        expect(Object.keys(second.retainedAssets ?? {})).toEqual([
          "/assets/chunk-2.js",
        ]);
        yield* expectUrlContains(
          `${second.url!}/assets/chunk-2.js`,
          marker(2),
          { timeout: "60 seconds", label: "build 2 chunk" },
        );
        yield* expectUrlContains(
          `${second.url!}/assets/chunk-1.js`,
          marker(1),
          { timeout: "60 seconds", label: "build 1 chunk carried" },
        );

        const third = yield* deploy(3);
        yield* expectUrlContains(`${third.url!}/assets/chunk-3.js`, marker(3), {
          timeout: "60 seconds",
          label: "build 3 chunk",
        });
        yield* expectUrlContains(`${third.url!}/assets/chunk-2.js`, marker(2), {
          timeout: "60 seconds",
          label: "build 2 chunk carried",
        });
        yield* expectUrlAbsent(`${third.url!}/assets/chunk-1.js`, marker(1), {
          timeout: "60 seconds",
          label: "build 1 chunk carried only once",
        });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(
                Effect.ignore,
              );
            }
          }),
        ),
      );
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 300_000,
  },
);
