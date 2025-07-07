import { describe, expect, test } from "bun:test";
import { $ } from "bun";

describe("BunSQLiteStateStore", () => {
  createTest({
    runtime: "bun",
    store: "bun-sqlite",
    file: "alchemy-bun-sqlite.sqlite",
  });
});

describe("D1StateStore", () => {
  createTest({ runtime: "bun", store: "d1" });
  createTest({ runtime: "tsx", store: "d1" });
});

describe("BetterSQLite3StateStore", () => {
  createTest({
    runtime: "tsx",
    store: "better-sqlite3",
    file: "alchemy-tsx-better-sqlite3.sqlite",
  });
});

describe("LibSQLStateStore", () => {
  createTest({
    runtime: "bun",
    store: "libsql",
    file: "alchemy-bun-libsql.sqlite",
  });
  createTest({
    runtime: "tsx",
    store: "libsql",
    file: "alchemy-tsx-libsql.sqlite",
  });
});

interface CreateTestOptions {
  runtime: "bun" | "tsx";
  store: "d1" | "bun-sqlite" | "better-sqlite3" | "libsql";
  timeout?: number;
  file?: string;
}

function createTest({
  runtime,
  store,
  timeout = 60_000,
  file,
}: CreateTestOptions) {
  const command = runtime === "bun" ? "run" : "tsx";
  test(
    runtime,
    async () => {
      await $`ALCHEMY_STATE_FILE=${file} bun ${command} test/alchemy.run.ts ${store} --stage "${runtime}-${store}"`;
      await $`ALCHEMY_STATE_FILE=${file} bun ${command} test/alchemy.run.ts ${store} --stage "${runtime}-${store}" --destroy`;
      if (file) {
        expect(Bun.file(file).exists()).resolves.toBe(true);
        expect(Bun.file(file).delete()).resolves.toBeUndefined();
      }
    },
    {
      timeout,
    }
  );
}
