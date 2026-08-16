/**
 * The serve-bridge module-graph boundary (the enforcement half of the
 * bridge refactor): the neutral `alchemy/Serve` core — the shared
 * mechanism in `Bridge.ts` (memoized instance builds + healing, request
 * scopes, settle strategy) plus the dispatcher, routes, env guard, and
 * constants — must not STATICALLY import either cloud. The cloud recipes
 * (`Cloudflare/Workers/ServeBridge.ts`, `AWS/Lambda/ServeBridge.ts`) ride
 * each site class's own import graph via `SERVE_BRIDGE_KEY` instead, so a
 * foreign bundler never carries both clouds.
 *
 * The one sanctioned exception is DYNAMIC import — `Serve.ts`'s lazy
 * fallback for classes whose factory does not stamp a bridge yet — which
 * this scan deliberately ignores (static `import ... from` only).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

describe("serve bridge core", () => {
  it.effect("the neutral Serve core statically imports neither cloud", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const roots = [
        "Serve/Bridge.ts",
        "Serve/Serve.ts",
        "Serve/Routes.ts",
        "Serve/Env.ts",
        "Serve/constants.ts",
        "Serve/Rpc.ts",
        "Serve/index.ts",
      ];
      const seen = new Set<string>();
      const queue = [...roots];
      const offenders: string[] = [];
      while (queue.length > 0) {
        const rel = queue.pop()!;
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (/^(Cloudflare|AWS)\//.test(rel)) {
          offenders.push(rel);
          continue;
        }
        const source = yield* fs
          .readFileString(NodePath.join(SRC, rel))
          .pipe(Effect.orElseSucceed(() => ""));
        for (const match of source.matchAll(
          /^(?:import|export)[^;'"]*?from\s+"(\.[^"]+)";?/gms,
        )) {
          queue.push(
            NodePath.normalize(
              NodePath.join(NodePath.dirname(rel), match[1]),
            ).replaceAll("\\", "/"),
          );
        }
      }
      expect(offenders).toEqual([]);
      // Sanity: the traversal actually walked a real graph.
      expect(seen.size).toBeGreaterThan(7);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "the value-form client graph never reaches the mount-marker module",
    () =>
      Effect.gen(function* () {
        // `__ALCHEMY_SERVE_MOUNT_v1__` in a built server bundle means "the
        // user explicitly mounted alchemy/Serve" — the framework
        // generators' stand-down scan then SKIPS wrapper injection. The
        // marker literal lives only in Serve/Serve.ts, so Client/Server.ts
        // (which rides every createClient backend graph) must never
        // statically import it. Regression: 2026-08-16, bridgeOf imported
        // from Serve.ts put the marker in every value-form backend bundle
        // and the CF nextjs/sveltekit workers deployed WITHOUT their
        // queue exports.
        const fs = yield* FileSystem.FileSystem;
        const seen = new Set<string>();
        const queue = ["Client/Server.ts"];
        while (queue.length > 0) {
          const rel = queue.pop()!;
          if (seen.has(rel)) continue;
          seen.add(rel);
          const source = yield* fs
            .readFileString(NodePath.join(SRC, rel))
            .pipe(Effect.orElseSucceed(() => ""));
          for (const match of source.matchAll(
            /^(?:import|export)[^;'"]*?from\s+"(\.[^"]+)";?/gms,
          )) {
            queue.push(
              NodePath.normalize(
                NodePath.join(NodePath.dirname(rel), match[1]),
              ).replaceAll("\\", "/"),
            );
          }
        }
        expect(seen.has("Serve/Serve.ts")).toBe(false);
        expect(seen.size).toBeGreaterThan(3);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("both cloud recipes exist and stamp the same bridge key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const recipe of [
        "Cloudflare/Workers/ServeBridge.ts",
        "AWS/Lambda/ServeBridge.ts",
      ]) {
        const source = yield* fs.readFileString(NodePath.join(SRC, recipe));
        expect(source).toContain("makeBridgeCore");
        expect(source).toContain("SERVE_BRIDGE_KEY");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
