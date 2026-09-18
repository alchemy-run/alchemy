import * as Cloudflare from "@/Cloudflare/index.ts";
import {
  runtimeProviders,
  runtimeTransport,
} from "./support/runtime-providers.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ForgejoWorker from "./fixtures/worker.ts";
import { Repository, OtherRepository } from "./fixtures/repository.ts";
import { verifyRuntime } from "./support/runtime.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers().pipe(Layer.provide(runtimeTransport)),
    runtimeProviders,
  ),
});
const program = Effect.gen(function* () {
  const host = yield* ForgejoWorker;
  return {
    url: host.url,
    host,
    repository: yield* Repository,
    other: yield* OtherRepository,
  };
});
test.provider.skipIf(process.env.FORGEJO_RUNTIME_TEST !== "1")(
  "live: Worker automatic Forgejo auth and signed events",
  (stack) =>
    verifyRuntime(stack, program, Effect.all([Repository, OtherRepository])),
  { timeout: 120_000 },
);
