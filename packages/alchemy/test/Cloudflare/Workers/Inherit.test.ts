import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Redacted from "effect/Redacted";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const script = `export default { fetch(_request, env) { return new Response(env.SOURCE_MARK ?? "missing"); } };`;

describe("Cloudflare.Workers.Inherit", () => {
  test("emits a value-free inherit marker pinned to latest", () => {
    const binding = Cloudflare.Workers.Inherit("API_TOKEN");
    expect(Cloudflare.Workers.isInherit(binding)).toBe(true);
    expect(binding.toWorkerBinding()).toEqual({
      type: "inherit",
      name: "API_TOKEN",
      versionId: "latest",
    });
    expect(JSON.stringify(binding.toWorkerBinding())).not.toMatch(
      /text|json|value|secret/i,
    );
    expect(Cloudflare.Workers.bindingsInheritFor(undefined)).toBeUndefined();
    expect(
      Cloudflare.Workers.bindingsInheritFor([
        { type: "inherit", name: "API_TOKEN" },
      ]),
    ).toBe("strict");
  });

  test.provider(
    "inherits named bindings from the previous upload and fails closed for a missing name",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        yield* stack.deploy(
          Cloudflare.Worker("InheritWorker", {
            script,
            env: {
              SOURCE_MARK: "from-v1",
              API_TOKEN: Redacted.make("retained-secret-value"),
            },
          }),
        );

        const inherited = yield* stack.deploy(
          Cloudflare.Worker("InheritWorker", {
            script,
            env: {
              SOURCE_MARK: Cloudflare.Workers.Inherit(),
              API_TOKEN: Cloudflare.Workers.Inherit(),
            },
          }),
        );

        yield* expectUrlContains(inherited.url!, "from-v1", {
          label: "inherited plaintext marker remains at runtime",
        });

        const { accountId } = yield* yield* CloudflareEnvironment;
        const settings = yield* workers.getScriptScriptAndVersionSetting({
          accountId,
          scriptName: inherited.workerName,
        });
        expect(settings.bindings).toContainEqual(
          expect.objectContaining({
            type: "plain_text",
            name: "SOURCE_MARK",
            text: "from-v1",
          }),
        );
        expect(settings.bindings).toContainEqual(
          expect.objectContaining({
            type: "secret_text",
            name: "API_TOKEN",
          }),
        );
        expect(JSON.stringify(settings.bindings)).not.toContain(
          "retained-secret-value",
        );

        const failure = yield* stack
          .deploy(
            Cloudflare.Worker("InheritWorker", {
              script,
              env: {
                MISSING: Cloudflare.Workers.Inherit(),
              },
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(/inherit|MISSING|10057/i),
          }),
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
});
