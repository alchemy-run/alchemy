import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import ImagesWorker from "./images-worker.ts";

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * 1x1 red PNG — a known-good minimal image that Cloudflare Images
 * accepts and reports as `image/png`, 1x1. The test uploads this to
 * the worker, which forwards the request stream straight into
 * `images.info()`.
 */
const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const { test } = Test.make({ providers: Cloudflare.providers() });
const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");

test.provider("worker bindings emit Cloudflare Images metadata", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("ImageWorker", {
          main,
          bindings: {
            MEDIA: Cloudflare.Images({ name: "IGNORED_BY_DIRECT_BINDING" }),
          },
        });
      }),
    );

    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName: worker.workerName,
    });
    expect(settings.bindings).toEqual(
      expect.arrayContaining([
        {
          type: "images",
          name: "MEDIA",
        },
      ]),
    );

    yield* stack.destroy();
  }),
);

test.provider("init-phase binding emits Cloudflare Images metadata", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        const images = yield* Cloudflare.Images({ name: "IMAGE_PIPELINE" });

        return yield* Cloudflare.Worker(
          "ImageWorker",
          {
            main,
          },
          Effect.gen(function* () {
            yield* Cloudflare.Images.bind(images);
          }).pipe(Effect.provide(Cloudflare.ImagesBindingLive)),
        );
      }),
    );

    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName: worker.workerName,
    });
    expect(settings.bindings).toEqual(
      expect.arrayContaining([
        {
          type: "images",
          name: "IMAGE_PIPELINE",
        },
      ]),
    );

    yield* stack.destroy();
  }),
);

/**
 * End-to-end Images binding behaviour via the Effect-native interface.
 *
 * The worker (see `./images-worker.ts`) yields `Cloudflare.Images.bind(...)`
 * in its init phase and forwards the request body — typed as
 * `Stream.Stream<Uint8Array>` — directly into `images.info(stream)`. The
 * test uploads a tiny PNG and asserts Cloudflare Images parsed it,
 * proving the binding is wired up and the Effect-native client correctly
 * converts an Effect Stream into the runtime ReadableStream the binding
 * expects.
 */
test.provider(
  "init-phase binding can call images.info() against Cloudflare Images",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ImagesWorker;
        }),
      );

      expect(worker.url).toBeTypeOf("string");

      // Cloudflare's edge takes a few seconds to start serving a fresh
      // workers.dev URL — initial requests can return Cloudflare's
      // "There is nothing here yet" 404 page. Retry until the worker
      // starts answering 200 (and surface its body if it doesn't, so a
      // real failure isn't hidden by the retry loop).
      const info = yield* HttpClient.execute(
        HttpClientRequest.post(worker.url!).pipe(
          HttpClientRequest.bodyUint8Array(TINY_PNG),
        ),
      ).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : res.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(new WorkerNotReady({ status: res.status, body })),
                ),
              ),
        ),
        Effect.retry({
          while: (e): e is WorkerNotReady =>
            e instanceof WorkerNotReady && e.status >= 400 && e.status < 500,
          schedule: Schedule.exponential("500 millis").pipe(
            Schedule.both(Schedule.recurs(20)),
          ),
        }),
      );

      expect(info).toMatchObject({
        format: "image/png",
        width: 1,
        height: 1,
      });

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
