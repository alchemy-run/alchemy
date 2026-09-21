import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  callbackEnvironment,
  makeCallbackHarness,
} from "./fixtures/alarm-callback/harness.ts";
import type { Snapshot } from "./fixtures/alarm-callback/types.ts";

it.effect(
  "declares the Celld callback fixture without native initialization",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(
        () => import("./fixtures/alarm-callback/worker.ts"),
      );
      expect(typeof fixture.default).toBe("function");
      expect(Effect.isEffect(makeCallbackHarness)).toBe(true);
    }),
);

it.effect.skipIf(callbackEnvironment.enabled)(
  "refuses native setup before explicit exclusive-publication authorization",
  () =>
    makeCallbackHarness.pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() =>
          expect(error.message).toContain("exclusive publication"),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
);

it.live.skipIf(!callbackEnvironment.enabled)(
  "Celld Application callbacks preserve legacy schemas, transactions, recovery and bounded batches",
  () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const harness = yield* makeCallbackHarness;
      const request = <T>(name: string, operation = "snapshot") =>
        Effect.gen(function* () {
          const url = `${callbackEnvironment.workerUrl}/${name}/${operation}`;
          const response = yield* (
            operation === "snapshot" ? http.get(url) : http.post(url)
          ).pipe(Effect.timeout("8 seconds"));
          const body = yield* response.text;
          if (response.status !== 200)
            return yield* Effect.fail(
              new Error(`${url}: HTTP ${response.status}: ${body}`),
            );
          return yield* Effect.try({
            try: () => JSON.parse(body) as T,
            catch: (cause) =>
              new Error(`Invalid callback fixture response from ${url}`, {
                cause,
              }),
          });
        });
      const snapshot = (name: string) => request<Snapshot>(name);
      const poll = (name: string, until: (value: Snapshot) => boolean) =>
        snapshot(name).pipe(
          Effect.repeat({
            until,
            schedule: Schedule.spaced("1 second"),
            times: 10,
          }),
          Effect.tap((value) =>
            Effect.sync(() => expect(until(value)).toBe(true)),
          ),
        );
      const upgradeNames = ["upgrade", "schema-rollback", "schema-future"];
      const modes = [
        "atomic",
        "rollback",
        "rollback-defect",
        "rollback-interrupt",
        "replace",
        "retry",
        "reset",
        "batch",
      ];
      const names = [...upgradeNames, ...modes, "owner", "explicit"];
      let activeVersion: "v1" | "v2" | undefined;
      yield* Effect.acquireUseRelease(
        Effect.succeed(names),
        () =>
          Effect.gen(function* () {
            const first = yield* harness.publish("v1");
            activeVersion = "v1";
            const originals = new Map<string, Snapshot>();
            for (const name of upgradeNames) {
              yield* request(name, "clear");
              yield* request(
                name,
                name === "schema-future" ? "seed?future=1" : "seed",
              );
              const before = yield* poll(
                name,
                (value) =>
                  value.delivered.includes("legacy:v1-proof") &&
                  value.legacy.length === 3,
              );
              expect(before.version).toBe("v1");
              expect(before.schemaVersion).toBe(
                name === "schema-future" ? 99 : null,
              );
              expect(before.marker).toBe("written-by-v1");
              originals.set(name, before);
            }
            const second = yield* harness.publish("v2");
            activeVersion = "v2";
            expect(second.worker.workerName).toBe(first.worker.workerName);
            expect(second.application.revision).not.toBe(
              first.application.revision,
            );
            for (const name of upgradeNames) {
              const before = originals.get(name)!;
              const restored = yield* snapshot(name);
              expect(restored.version).toBe("v2");
              expect(restored.id).toBe(before.id);
              expect(restored.boots).toBeGreaterThan(before.boots);
              expect(restored.marker).toBe(before.marker);
              expect(restored.legacy).toEqual(before.legacy);
              expect(restored.schemaVersion).toBe(before.schemaVersion);
              expect(restored.pending).toEqual([]);
            }
            const future = yield* request<{
              failure: string;
              before: Snapshot;
              after: Snapshot;
            }>("schema-future", "probe?kind=future");
            expect(future.failure).toBe("UnsupportedAlarmSchemaVersion");
            expect(future.after).toEqual(future.before);
            const rolledBack = yield* request<{
              failure: string;
              before: Snapshot;
              after: Snapshot;
            }>("schema-rollback", "probe?kind=rollback");
            expect(rolledBack.failure).toBe("Rollback");
            expect(rolledBack.after).toEqual(rolledBack.before);
            expect(rolledBack.after.schemaVersion).toBeNull();
            for (const name of ["upgrade", "schema-rollback"]) {
              const migrated = yield* request<Snapshot>(
                name,
                "seed?mode=upgrade",
              );
              expect(migrated.schemaVersion).toBe(1);
              expect(migrated.marker).toBe("written-by-v1");
              const delivered = yield* poll(
                name,
                (value) =>
                  value.delivered.includes("upgraded") &&
                  value.delivered.includes("legacy:legacy-one") &&
                  value.delivered.includes("legacy:legacy-repeat"),
              );
              expect(delivered.id).toBe(originals.get(name)!.id);
              expect(delivered.delivered).not.toContain("legacy:legacy-cancel");
              const repeating = yield* poll(
                name,
                (value) =>
                  value.delivered.filter(
                    (item) => item === "legacy:legacy-repeat",
                  ).length >= 2,
              );
              expect(repeating.legacy.map((row) => row.id)).toEqual([
                "legacy-repeat",
              ]);
              yield* request(name, "cancel-legacy-repeat");
              const drained = yield* poll(
                name,
                (value) =>
                  value.alarm === null &&
                  value.pending.length === 0 &&
                  value.legacy.length === 0,
              );
              expect(drained.schemaVersion).toBe(1);
            }
            for (const mode of modes) {
              yield* request(mode, "clear");
              const initial = yield* request<Snapshot>(
                mode,
                `seed?mode=${mode}`,
              );
              if (mode.startsWith("rollback")) {
                expect(initial.marker).toBeNull();
                expect(initial.cleanupWrite).toBeNull();
                expect(initial.rows).toEqual([]);
                expect(initial.delivered).toEqual([]);
                expect(initial.pending).toEqual([{ id: "keep" }]);
                expect(initial.transaction?.failure).toBe(
                  mode === "rollback"
                    ? "Rollback"
                    : mode === "rollback-defect"
                      ? "rollback-defect"
                      : "interrupted",
                );
                expect(initial.transaction?.cleanupFinished).toBe(true);
                expect(initial.transaction?.alarmBefore).not.toBeNull();
                expect(initial.transaction?.alarmAfter).toBe(
                  initial.transaction?.alarmBefore,
                );
                continue;
              }
              const count =
                mode === "batch"
                  ? 105
                  : mode === "atomic" || mode === "replace"
                    ? 2
                    : 1;
              const done = yield* poll(
                mode,
                (value) =>
                  value.delivered.length === count &&
                  value.alarm === null &&
                  value.userAlarmAfterCallbacks,
              );
              expect(done.pending).toEqual([]);
              expect(done.userAlarmAfterCallbacks).toBe(true);
              if (mode === "atomic") {
                expect(done.marker).toBe("committed");
                expect(done.rows).toEqual([{ value: "committed" }]);
                expect(done.delivered.sort()).toEqual([
                  "committed",
                  "transactional-init",
                ]);
              }
              if (mode === "replace")
                expect(done.delivered).toEqual(["first", "second"]);
              if (mode === "retry" || mode === "reset") {
                expect(done.attempts).toBeGreaterThan(1);
                expect(done.recovery).not.toBeNull();
              }
              if (mode === "reset")
                expect(done.boots).toBeGreaterThan(initial.boots);
              if (mode === "batch") {
                expect(done.bookkeeping).toEqual({
                  schemaChecks: 1,
                  reconciliations: 1,
                  setAlarm: 1,
                  deleteAlarm: 0,
                });
                expect(new Set(done.delivered).size).toBe(105);
                expect(done.delivered).toContain("nested");
                expect(done.delivered).toContain("finalizer");
              }
            }
            for (const kind of ["owner", "explicit"]) {
              yield* request(kind, "clear");
              const result = yield* request<{
                failure: string;
                foreignWrite: string | null;
                after: Snapshot;
              }>(kind, `probe?kind=${kind}`);
              expect(result.failure).toBe("DurableObjectStorageError");
              expect(result.foreignWrite).toBeNull();
              expect(result.after.marker).toBeNull();
            }
            expect(yield* request("atomic", "late")).toBe("CallbackError");
          }),
        (names) =>
          Effect.forEach(
            activeVersion === undefined
              ? []
              : activeVersion === "v1"
                ? upgradeNames
                : names,
            (name) => request(name, "clear").pipe(Effect.orDie),
            { discard: true },
          ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          Layer.succeed(
            Endpoint,
            callbackEnvironment.nodeUrl ?? "http://127.0.0.1:1",
          ),
        ),
      ),
    ),
  { timeout: 120_000 },
);
