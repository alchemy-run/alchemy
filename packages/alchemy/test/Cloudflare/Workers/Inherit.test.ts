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
  test.provider(
    "refuses inherit on a greenfield Worker with no previous upload",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const failure = yield* stack
          .deploy(
            Cloudflare.Worker("InheritGreenfield", {
              script,
              env: {
                API_TOKEN: Cloudflare.Workers.Inherit(),
              },
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toEqual(
          expect.objectContaining({
            _tag: "WorkerInheritConfigError",
            message: expect.stringMatching(/existing/i),
          }),
        );
        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "refuses inherit combined with version.traffic",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        yield* stack.deploy(
          Cloudflare.Worker("InheritVersion", {
            script,
            env: { SOURCE_MARK: "from-v1" },
          }),
        );
        const failure = yield* stack
          .deploy(
            Cloudflare.Worker("InheritVersion", {
              script,
              version: { traffic: 0 },
              env: { SOURCE_MARK: Cloudflare.Workers.Inherit() },
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toEqual(
          expect.objectContaining({
            _tag: "WorkerInheritConfigError",
            message: expect.stringMatching(/version/i),
          }),
        );
        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "refuses inherit when an undeployed preview is the latest upload",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const live = yield* stack.deploy(
          Cloudflare.Worker("InheritPreviewPoison", {
            script,
            env: {
              SOURCE_MARK: "from-v100",
              API_TOKEN: Redacted.make("retained-secret-value"),
            },
          }),
        );

        yield* stack.deploy(
          Cloudflare.Worker("InheritPreviewPoison", {
            script,
            version: { traffic: 0, message: "undeployed inherit preview" },
            env: {
              SOURCE_MARK: "from-preview",
            },
          }),
        );

        const { accountId } = yield* yield* CloudflareEnvironment;
        const listed = yield* workers.listScriptVersions({
          accountId,
          scriptName: live.workerName,
          perPage: 5,
        });
        const { deployments } = yield* workers.listScriptDeployments({
          accountId,
          scriptName: live.workerName,
        });
        const latestUploaded = listed.items?.[0]?.id;
        const liveId = (deployments[0]?.versions ?? []).find(
          (version) => version.percentage === 100,
        )?.versionId;
        expect(latestUploaded).toBeDefined();
        expect(liveId).toBeDefined();
        expect(latestUploaded).not.toEqual(liveId);

        const failure = yield* stack
          .deploy(
            Cloudflare.Worker("InheritPreviewPoison", {
              script,
              env: {
                SOURCE_MARK: Cloudflare.Workers.Inherit(),
                API_TOKEN: Cloudflare.Workers.Inherit(),
              },
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toEqual(
          expect.objectContaining({
            _tag: "WorkerInheritConfigError",
            message: expect.stringMatching(/100%|latest upload/i),
          }),
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

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
