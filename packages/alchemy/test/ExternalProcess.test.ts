import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import {
  ExternalProcess,
  ExternalProcessProvider,
  formatEnvFile,
  runtime,
} from "@/ExternalProcess.ts";
import { packEnvValue } from "@/RuntimeContext.ts";
import { inMemoryState } from "@/State";
import { WebhookHost } from "@/WebhookHost.ts";

const { test } = Test.make({
  providers: ExternalProcessProvider(),
  state: inMemoryState(),
});

// The program of the process: one secret read through `Config` (bound like
// any binding's value) and one webhook with its signing secret.
const program = Effect.gen(function* () {
  const apiKey = yield* Config.Redacted("API_KEY");
  const host = yield* WebhookHost;
  yield* host.bind("webhook", { env: { WEBHOOK_SECRET: Redacted.make("whsec_1") } });
  yield* host.route("/hooks/stripe", (request) =>
    Effect.promise(async () => new Response(`${request.method} ${await request.text()}`)),
  );
  return { apiKey };
});

const declare = (envFile?: string) =>
  ExternalProcess(
    "Api",
    { url: "https://api.example.com", envFile, env: { LOG_LEVEL: "info" } },
    program,
  ).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ API_KEY: "sk_test_1" }),
    ),
  );

describe("ExternalProcess deploy", { tags: ["unit", "local"] }, () => {
  test.provider("plan records the bound values in the process's variables", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const envFile = `${dir}/api.env`;

      const api = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* declare(envFile);
          return { url: api.url, variables: api.variables };
        }),
      );

      expect(api.url).toBe("https://api.example.com");
      const variables = api.variables as Record<string, unknown>;
      expect(variables.ALCHEMY_STACK_NAME).toBeTypeOf("string");
      expect(variables.ALCHEMY_STAGE).toBeTypeOf("string");
      expect(variables.ALCHEMY_PHASE).toBe("runtime");
      expect(variables.LOG_LEVEL).toBe("info");
      // Secrets stay Redacted in the attribute; the value inside is the packed
      // form the runtime reads back.
      expect(Redacted.isRedacted(variables.API_KEY)).toBe(true);
      expect(Redacted.value(variables.API_KEY as Redacted.Redacted<string>)).toBe(
        packEnvValue(Redacted.make("sk_test_1")),
      );
      expect(Redacted.isRedacted(variables.WEBHOOK_SECRET)).toBe(true);

      const text = yield* fs.readFileString(envFile);
      expect(text).toContain('LOG_LEVEL="info"');
      expect(text).toContain(`API_KEY="{\\"_tag\\":\\"Redacted\\",\\"value\\":\\"sk_test_1\\"}"`);
      expect(text).toContain('WEBHOOK_SECRET="');
      const info = yield* fs.stat(envFile);
      expect(info.mode & 0o777).toBe(0o600);

      yield* stack.destroy();
      expect(yield* fs.exists(envFile)).toBe(false);
    }),
  );
});

test(
  'formatEnvFile writes one escaped, sorted KEY="value" line per variable',
  Effect.sync(() => {
    expect(
      formatEnvFile({
        B: 'say "hi"\\now',
        A: Redacted.make("line1\nline2"),
      }),
    ).toBe('A="line1\\nline2"\nB="say \\"hi\\"\\\\now"\n');
  }),
  { tags: ["unit", "local"] },
);

test(
  "runtime reads the bound values back from process.env and serves the webhook routes",
  Effect.gen(function* () {
    const env = {
      ALCHEMY_STACK_NAME: "app",
      ALCHEMY_STAGE: "prod",
      ALCHEMY_PHASE: "runtime",
      API_KEY: packEnvValue(Redacted.make("sk_live_9")),
      WEBHOOK_SECRET: packEnvValue(Redacted.make("whsec_9")),
    };
    const previousEnv = { ...process.env };
    const previousPhase = globalThis.__ALCHEMY_RUNTIME__;
    const scope = yield* Scope.make();
    yield* Effect.gen(function* () {
      Object.assign(process.env, env);
      globalThis.__ALCHEMY_RUNTIME__ = true;
      // Declared after the phase is set, as a process's entry imports it.
      const api = yield* runtime<{ apiKey: Redacted.Redacted<string> }>(
        ExternalProcess("Api", { url: "https://api.example.com" }, program),
      ).pipe(Scope.provide(scope));

      expect(Redacted.value(api.shape.apiKey)).toBe("sk_live_9");
      expect(api.handle(new Request("https://api.example.com/other"))).toBeUndefined();
      const claimed = api.handle(
        new Request("https://api.example.com/hooks/stripe", { method: "POST", body: "evt" }),
      );
      expect(claimed).toBeDefined();
      const response = yield* claimed!;
      expect(yield* Effect.promise(() => response.text())).toBe("POST evt");
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void);
          globalThis.__ALCHEMY_RUNTIME__ = previousPhase;
          for (const key of Object.keys(env)) {
            if (previousEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnv[key];
          }
        }),
      ),
    );
  }),
  { tags: ["unit", "local"] },
);

test(
  "runtime refuses to run outside the runtime phase",
  Effect.gen(function* () {
    const previousPhase = globalThis.__ALCHEMY_RUNTIME__;
    globalThis.__ALCHEMY_RUNTIME__ = undefined;
    const exit = yield* Effect.exit(Effect.scoped(runtime(Effect.never)));
    globalThis.__ALCHEMY_RUNTIME__ = previousPhase;
    expect(Exit.isFailure(exit)).toBe(true);
  }),
  { tags: ["unit", "local"] },
);
