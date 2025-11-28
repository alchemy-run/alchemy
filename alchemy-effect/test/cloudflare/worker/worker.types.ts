import { CloudflareAccountId, CloudflareApi } from "@/cloudflare/api";
import * as CloudflareLive from "@/cloudflare/live";
import * as R2 from "@/cloudflare/r2";
import * as Worker from "@/cloudflare/worker";
import * as Assets from "@/cloudflare/worker/assets.fetch";
import { $, apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const main = pathe.resolve(import.meta.dirname, "worker.ts");

{
  class Bucket extends R2.Bucket("Bucket", {
    name: "test-bucket-initial",
    storageClass: "Standard",
  }) {}
  class Bucket2 extends R2.Bucket("Bucket2", {
    name: "test-bucket-2",
    storageClass: "Standard",
  }) {}

  const worker = Worker.serve("TestWorker", {
    fetch: Effect.fn(function* (request) {
      yield* R2.get(Bucket, "test");
      return new Response("Hello from TestWorker v1");
    }),
  });
  {
    class TestWorker extends worker({
      main,
      bindings: $(R2.Bind(Bucket)),
    }) {}
  }
  {
    class TestWorker extends worker({
      main,
      // @ts-expect-error - missing R2.Bind(Bucket)
      bindings: $(),
    }) {}
  }
  {
    class TestWorker extends worker({
      main,
      // @ts-expect-error - additononal R2.Bind(Bucket2)
      bindings: $(R2.Bind(Bucket), R2.Bind(Bucket2)),
    }) {}
  }
}
