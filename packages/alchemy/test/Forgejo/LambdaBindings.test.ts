import * as AWS from "@/AWS/index.ts";
import {
  runtimeProviders,
  runtimeTransport,
} from "./support/runtime-providers.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ForgejoFunctionLive, { ForgejoFunction } from "./fixtures/lambda.ts";
import { Repository, OtherRepository } from "./fixtures/repository.ts";
import { verifyRuntime } from "./support/runtime.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(
    AWS.providers().pipe(Layer.provide(runtimeTransport)),
    runtimeProviders,
  ),
});
const program = Effect.gen(function* () {
  const host = yield* ForgejoFunction;
  return {
    url: host.functionUrl,
    host,
    repository: yield* Repository,
    other: yield* OtherRepository,
  };
}).pipe(Effect.provide(ForgejoFunctionLive));
test.provider.skipIf(process.env.FORGEJO_RUNTIME_TEST !== "1")(
  "live: Lambda automatic Forgejo auth and signed events",
  (stack) =>
    verifyRuntime(stack, program, Effect.all([Repository, OtherRepository])),
  { timeout: 120_000 },
);
