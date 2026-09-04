import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import { loadVarlockEnvironment } from "@/Varlock/SecretManager.ts";

const fixture = fileURLToPath(import.meta.resolve("./fixtures/resolve.ts"));
const projectFixture = fileURLToPath(
  new URL("./fixtures/project/", import.meta.url),
);
const loadPathFixture = fileURLToPath(
  new URL("./fixtures/load-path/", import.meta.url),
);
const nativeFixture = fileURLToPath(
  new URL("./fixtures/native/", import.meta.url),
);
const invalidFixture = fileURLToPath(
  new URL("./fixtures/invalid/", import.meta.url),
);
const missingFixture = fileURLToPath(
  new URL("./fixtures/missing/", import.meta.url),
);
const missingPeerFixture = fileURLToPath(
  new URL("./fixtures/missing-peer.ts", import.meta.url),
);
const patchProbe = fileURLToPath(
  new URL("./fixtures/patch-probe.mjs", import.meta.url),
);

const runFixtureWithEnv = (
  directory: string,
  envOverrides: Readonly<Record<string, string | undefined>>,
  ...stages: string[]
) => {
  const env = { ...process.env, ...envOverrides };
  if (!("ALCHEMY_STAGE" in envOverrides)) delete env.ALCHEMY_STAGE;
  delete env.__VARLOCK_ENV;
  const result = spawnSync(process.execPath, [fixture, directory, ...stages], {
    cwd: directory,
    encoding: "utf8",
    env,
  });
  expect(result.status, result.stderr).toBe(0);
  const output = result.stdout.trim().split("\n").at(-1);
  expect(output, result.stderr).toBeDefined();
  return JSON.parse(output!) as {
    resolved?: Array<{
      stack: string;
      stage?: string;
      apiKey: string;
      fallback: string;
      privateBindingForwarded: boolean;
    }>;
    error?: { tag?: string; message: string };
    secretBindings?: ReadonlyArray<{
      readonly type: string;
      readonly name: string;
      readonly text?: string;
    }>;
    consolePatched: boolean;
    stackRestored: boolean;
    stageRestored: boolean;
    privateBlobRestored: boolean;
  };
};

const runFixture = (directory: string, ...stages: string[]) =>
  runFixtureWithEnv(directory, {}, ...stages);

test("exports the adapter from alchemy/Varlock", async () => {
  const adapter = await import("alchemy/Varlock");
  expect(adapter.secrets).toBeTypeOf("function");
});

test("loads stage-specific values with fallback and restores process globals", () => {
  const result = runFixture(projectFixture, "dev", "production");
  expect(result.error).toBeUndefined();
  expect(result.resolved).toEqual([
    {
      stack: "varlock-fixture",
      stage: "dev",
      apiKey: "dev-secret",
      fallback: "fallback",
      privateBindingForwarded: false,
    },
    {
      stack: "varlock-fixture",
      stage: "production",
      apiKey: "production-secret",
      fallback: "fallback",
      privateBindingForwarded: false,
    },
  ]);
  expect(result.consolePatched).toBe(false);
  expect(result.stackRestored).toBe(true);
  expect(result.stageRestored).toBe(true);
  expect(result.privateBlobRestored).toBe(true);
});

test("classifies adapter-backed Config.redacted values as secret bindings", () => {
  const result = runFixture(projectFixture, "dev");
  expect(result.secretBindings).toEqual([
    {
      type: "secret_text",
      name: "API_KEY",
      text: "dev-secret",
    },
  ]);
});

test("leaves stage-less environment selection to Varlock", () => {
  const result = runFixture(nativeFixture);
  expect(result.error).toBeUndefined();
  expect(result.resolved).toEqual([
    {
      stack: "varlock-fixture",
      apiKey: "native-secret",
      fallback: "fallback",
      privateBindingForwarded: false,
    },
  ]);
  expect(result.stackRestored).toBe(true);
});

test("preserves ambient ALCHEMY_STAGE during stage-less selection", () => {
  const result = runFixtureWithEnv(projectFixture, {
    ALCHEMY_STAGE: "production",
  });
  expect(result.error).toBeUndefined();
  expect(result.resolved).toEqual([
    {
      stack: "varlock-fixture",
      apiKey: "production-secret",
      fallback: "fallback",
      privateBindingForwarded: false,
    },
  ]);
  expect(result.stackRestored).toBe(true);
  expect(result.stageRestored).toBe(true);
});

test("uses Varlock's package.json loadPath", () => {
  const result = runFixture(loadPathFixture, "preview");
  expect(result.error).toBeUndefined();
  expect(result.resolved?.[0]?.apiKey).toBe("preview-secret");
});

test("maps Varlock validation failures to SecretManagerError", () => {
  const result = runFixture(invalidFixture, "test");
  expect(result.error?.tag).toBe("SecretManagerError");
  expect(result.error?.message).toContain("Varlock could not load or validate");
  expect(result.stageRestored).toBe(true);
  expect(result.privateBlobRestored).toBe(true);
});

test("maps missing required values to SecretManagerError", () => {
  const result = runFixtureWithEnv(
    missingFixture,
    { API_KEY: undefined },
    "test",
  );
  expect(result.error?.tag).toBe("SecretManagerError");
  expect(result.error?.message).toContain("Varlock could not load or validate");
  expect(result.stageRestored).toBe(true);
  expect(result.privateBlobRestored).toBe(true);
});

test("reports a missing optional Varlock peer with installation guidance", () => {
  const result = spawnSync(process.execPath, [missingPeerFixture], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const error = JSON.parse(result.stdout.trim()) as {
    tag: string;
    message: string;
  };
  expect(error.tag).toBe("SecretManagerError");
  expect(error.message).toContain("Varlock is configured");
  expect(error.message).toContain("pnpm add varlock");
});

test("does not invoke Varlock console or response patch APIs", async () => {
  const env = await Effect.runPromise(
    loadVarlockEnvironment(patchProbe, "patch-probe", undefined),
  );
  expect(env.ALCHEMY_VARLOCK_PATCH_PROBE_LOADED).toBe("true");
  expect(env.ALCHEMY_VARLOCK_PATCH_PROBE_CALLS).toBeUndefined();
});
