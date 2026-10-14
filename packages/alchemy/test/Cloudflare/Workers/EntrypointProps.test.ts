import { describe } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../Utils/Http.ts";
import Stack from "./fixtures/entrypoint-props/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const TENANT = `props=${JSON.stringify({ tenant: "acme" })}`;

describe(
  "ctx.props and self entrypoint stubs",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test(
      "an external request has empty props",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/props`, "props={}", { label: "external props" });
      }).pipe(logLevel),
      { timeout: 180_000 },
    );

    test(
      "a Worker handler mints a default entrypoint stub with props",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/mint`, `via-worker:${TENANT}`, {
          label: "worker loopback",
        });
      }).pipe(logLevel),
      { timeout: 180_000 },
    );

    test(
      "a Durable Object mints a host entrypoint stub with props",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/mint-do`, `via-do:${TENANT}`, {
          label: "durable object loopback",
        });
      }).pipe(logLevel),
      { timeout: 180_000 },
    );

    test(
      "an entrypoint the Worker does not export fails with a typed error",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/missing`, "EntrypointUnavailableError:Missing", {
          label: "missing entrypoint",
        });
      }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
