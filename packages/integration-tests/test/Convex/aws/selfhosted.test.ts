import { refuseProtected } from "@alchemy.run/convex/aws/StageDatabase";
import { parseAdminKey } from "@alchemy.run/convex/internal/adminKey";
import {
  assertInstanceNameUnchanged,
  assertNoReservedEnv,
  assertPinnedImage,
  assertStageHosts,
  backendEnv,
  backendTuning,
  type BackendEnv,
  databaseName,
  databaseUrl,
  instanceNameOf,
  isStagePrefix,
  stageHosts,
  storagePrefixPattern,
  withoutDatabaseName,
} from "@alchemy.run/convex/internal/selfhosted";
import { expect, it as test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const size = { cpu: 512, memory: 1024 };

test(
  "databaseName swaps hyphens for underscores",
  () => {
    expect(databaseName("my-app-pr-42")).toBe("my_app_pr_42");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "instanceNameOf is lowercase letters, digits and hyphens",
  () => {
    expect(instanceNameOf("MyApp", "Christian_Stamati")).toBe("myapp-christian-stamati");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "instanceNameOf stays short, and long names stay distinct",
  () => {
    const a = instanceNameOf("a".repeat(40), `${"b".repeat(40)}1`);
    const b = instanceNameOf("a".repeat(40), `${"b".repeat(40)}2`);
    expect(a.length).toBeLessThanOrEqual(48);
    expect(a).not.toBe(b);
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "storagePrefixPattern matches one instance's UUID prefix",
  () => {
    expect(storagePrefixPattern("pr")).toBe("pr-????????-????-????-????-????????????/*");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "isStagePrefix keeps a stage away from a longer stage's keys",
  () => {
    expect(isStagePrefix("pr", "pr-3f2b9c1e-0000-4000-8000-000000000000/a")).toBe(true);
    expect(isStagePrefix("pr", "pr-42-3f2b9c1e-0000-4000-8000-000000000000/a")).toBe(false);
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "backendEnv puts defaults under tuning under the user",
  () => {
    expect(backendEnv({ size, env: {} }).DOCUMENT_RETENTION_DELAY).toBe("172800");
    expect(backendEnv({ size, env: {} }).DISABLE_BEACON).toBe("true");
    expect(backendEnv({ size, env: {} }).APPLICATION_MAX_CONCURRENT_QUERIES).toBe("16");
    expect(backendEnv({ size, env: { RUST_LOG: "debug" } }).RUST_LOG).toBe("debug");
    expect(backendEnv({ size, env: { V8_THREADS: "9" } }).V8_THREADS).toBe("9");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "backendTuning scales with the task",
  () => {
    const small = backendTuning({ cpu: 256, memory: 512 });
    const large = backendTuning({ cpu: 1024, memory: 2048 });
    expect(small.V8_THREADS).toBe("2");
    expect(small.MAX_ISOLATE_WORKERS).toBe("8");
    expect(small.UDF_CACHE_MAX_SIZE).toBe(String(16 * 1024 * 1024));
    expect(large.RUNTIME_WORKER_THREADS).toBe("2");
    expect(large.MAX_ISOLATE_WORKERS).toBe("8");
    expect(large.INDEX_CACHE_SIZE).toBe(String(128 * 1024 * 1024));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "the CA paths are reserved",
  async () => {
    const error = await assertNoReservedEnv({ PG_CA_FILE: "x" }).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error.message).toContain("PG_CA_FILE");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertNoReservedEnv names what it refused",
  async () => {
    const error = await assertNoReservedEnv({ POSTGRES_URL: "x", OK: "y" }).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error._tag).toBe("ReservedEnvError");
    expect(error.message).toContain("POSTGRES_URL");
    expect(error.message).not.toContain("OK");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a reserved env name doesn't compile",
  () => {
    // @ts-expect-error set by the resource
    const env: BackendEnv = { POSTGRES_URL: "x" };
    // @ts-expect-error set by the resource
    const other: BackendEnv = { INSTANCE_SECRET: "x" };
    const allowed: BackendEnv = { RUST_LOG: "debug" };
    expect([env, other, allowed].length).toBe(3);
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertPinnedImage refuses a floating tag",
  async () => {
    const error = await assertPinnedImage("ghcr.io/convex/convex-backend:latest").pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error._tag).toBe("UnpinnedImage");
    await Effect.runPromise(
      assertPinnedImage(`ghcr.io/convex/convex-backend:latest@sha256:${"a".repeat(64)}`),
    );
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertInstanceNameUnchanged only refuses a real change",
  async () => {
    const error = await assertInstanceNameUnchanged("a", "b").pipe(Effect.flip, Effect.runPromise);
    expect(error._tag).toBe("InstanceNameChanged");
    await Effect.runPromise(assertInstanceNameUnchanged("a", "a"));
    await Effect.runPromise(assertInstanceNameUnchanged(undefined, "b"));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "withoutDatabaseName strips path and query",
  async () => {
    const url = await Effect.runPromise(
      withoutDatabaseName(Redacted.make("postgres://u:p@h:5432/db?ssl=true")),
    );
    expect(Redacted.value(url)).toBe("postgres://u:p@h:5432");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "withoutDatabaseName never repeats a URL it can't read",
  async () => {
    const error = await withoutDatabaseName(Redacted.make("not a url with p4ssw0rd")).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error._tag).toBe("InvalidDatabaseUrl");
    expect(error.message).not.toContain("p4ssw0rd");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "parseAdminKey takes the last key and ignores Docker pull noise",
  async () => {
    const stdout = [
      "latest: Pulling from convex/convex-backend",
      "Digest: sha256:abc",
      "Status: Downloaded newer image",
      "my-app|0123abcdef",
      "",
    ].join("\n");
    const key = await Effect.runPromise(parseAdminKey(stdout));
    expect(Redacted.value(key)).toBe("my-app|0123abcdef");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "parseAdminKey with no key fails without repeating its input",
  async () => {
    const error = await parseAdminKey("something secret happened").pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error._tag).toBe("AdminKeyNotFound");
    expect(error.message).not.toContain("secret happened");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "stageHosts for production",
  () => {
    expect(stageHosts("domain.com", "prod", true)).toEqual({
      web: "domain.com",
      cloud: "cloud.domain.com",
      site: "site.domain.com",
    });
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "stageHosts stay flat so one wildcard certificate covers them",
  () => {
    expect(stageHosts("dev.domain.com", "christian-stamati", false)).toEqual({
      web: "christian-stamati.dev.domain.com",
      cloud: "christian-stamati-cloud.dev.domain.com",
      site: "christian-stamati-site.dev.domain.com",
    });
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertStageHosts refuses a stage that takes another stage's host",
  async () => {
    const error = await assertStageHosts("x-cloud").pipe(Effect.flip, Effect.runPromise);
    expect(error._tag).toBe("InvalidStageName");
    await Effect.runPromise(assertStageHosts("pr-42"));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertStageHosts refuses what can't be a hostname label",
  async () => {
    await assertStageHosts("Bad_Stage").pipe(Effect.flip, Effect.runPromise);
    await assertStageHosts("a".repeat(60)).pipe(Effect.flip, Effect.runPromise);
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a protected stage database refuses to be dropped",
  async () => {
    const error = await refuseProtected({
      databaseName: "app_prod",
      url: Redacted.make("x"),
      deletionProtection: true,
    }).pipe(Effect.flip, Effect.runPromise);
    expect(error._tag).toBe("StageDatabaseProtected");
    expect(error.message).toContain("deletionProtection");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "an unprotected stage database may go",
  async () => {
    await Effect.runPromise(
      refuseProtected({
        databaseName: "app_pr_1",
        url: Redacted.make("x"),
        deletionProtection: false,
      }),
    );
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "databaseUrl turns TLS off only when asked, and only for postgres",
  async () => {
    const url = Redacted.make("postgres://u:p@h:5432/db?ssl=true");
    const plain = await Effect.runPromise(databaseUrl("postgres", url, false));
    expect(Redacted.value(plain)).toBe("postgres://u:p@h:5432?sslmode=disable");
    const strict = await Effect.runPromise(databaseUrl("postgres", url, true));
    expect(Redacted.value(strict)).toBe("postgres://u:p@h:5432");
    const mysql = await Effect.runPromise(
      databaseUrl("mysql", Redacted.make("mysql://u:p@h:3306"), false),
    );
    expect(Redacted.value(mysql)).toBe("mysql://u:p@h:3306");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "stageHosts uses the bare domain on prod, and a stage host elsewhere",
  () => {
    expect(stageHosts("example.com", "pr-42", false).cloud).toContain("pr-42");
    expect(stageHosts("example.com", "prod", true).cloud).toContain("example.com");
  },
  { tags: ["unit", "provider:convex", "local"] },
);
