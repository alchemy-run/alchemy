/**
 * Credential-free unit tests for the internal deploy engine's pure pieces:
 * content addressing, artifact hashing, and Build Output v3 tree assembly.
 * These run without a Vercel token (no API calls) — the live lifecycle
 * suites are in ../Projects and ../Functions.
 */
import {
  artifactFileFromBytes,
  artifactHash,
  sha1Hex,
} from "@/Vercel/Deploy/Artifact.ts";
import { fromFunctionBundle } from "@/Vercel/Deploy/BuildOutput.ts";
import { sensitiveFingerprint } from "@/Vercel/Deploy/Engine.ts";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

const bytes = (s: string) => new TextEncoder().encode(s);

const withNode = <A, E>(eff: Effect.Effect<A, E, any>) =>
  eff.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E, never>;

it.live("sha1Hex matches the known vector", () =>
  Effect.gen(function* () {
    // sha1("hello") — Vercel's upload content address.
    expect(yield* sha1Hex(bytes("hello"))).toEqual(
      "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
    );
  }),
);

it.live("artifact hash is order-independent and content-sensitive", () =>
  Effect.gen(function* () {
    const a = yield* artifactFileFromBytes("a.txt", bytes("aaa"));
    const b = yield* artifactFileFromBytes("b.txt", bytes("bbb"));
    const hash1 = yield* artifactHash([a, b]);
    const hash2 = yield* artifactHash([b, a]);
    expect(hash1).toEqual(hash2);

    const b2 = yield* artifactFileFromBytes("b.txt", bytes("BBB"));
    const hash3 = yield* artifactHash([a, b2]);
    expect(hash3).not.toEqual(hash1);
  }),
);

it.live("fromFunctionBundle assembles the Build Output v3 tree", () =>
  withNode(
    Effect.gen(function* () {
      const artifact = yield* fromFunctionBundle({
        bundle: [{ path: "index.mjs", bytes: bytes("export default {};") }],
        vcConfig: {
          runtime: "nodejs22.x",
          handler: "index.mjs",
          launcherType: "Nodejs",
          supportsResponseStreaming: true,
        },
        crons: [{ path: "/_alchemy/cron/x", schedule: "0 3 * * *" }],
        routes: [{ src: "/custom", dest: "/index" }],
      });

      const paths = artifact.files.map((f) => f.path).sort();
      expect(paths).toEqual([
        ".vercel/output/config.json",
        ".vercel/output/functions/index.func/.vc-config.json",
        ".vercel/output/functions/index.func/index.mjs",
      ]);

      const config = JSON.parse(
        new TextDecoder().decode(
          (
            artifact.files.find((f) => f.path === ".vercel/output/config.json")!
              .source as { _tag: "Bytes"; bytes: Uint8Array }
          ).bytes,
        ),
      );
      expect(config.version).toEqual(3);
      // Contributed routes come BEFORE the filesystem handler; the /index
      // catch-all is last.
      expect(config.routes).toEqual([
        { src: "/custom", dest: "/index" },
        { handle: "filesystem" },
        { src: "/.*", dest: "/index" },
      ]);
      expect(config.crons).toEqual([
        { path: "/_alchemy/cron/x", schedule: "0 3 * * *" },
      ]);

      // Same inputs → same hash (THE diff key must be deterministic).
      const again = yield* fromFunctionBundle({
        bundle: [{ path: "index.mjs", bytes: bytes("export default {};") }],
        vcConfig: {
          runtime: "nodejs22.x",
          handler: "index.mjs",
          launcherType: "Nodejs",
          supportsResponseStreaming: true,
        },
        crons: [{ path: "/_alchemy/cron/x", schedule: "0 3 * * *" }],
        routes: [{ src: "/custom", dest: "/index" }],
      });
      expect(again.hash).toEqual(artifact.hash);

      // Cron changes are artifact changes (they live in config.json).
      const noCron = yield* fromFunctionBundle({
        bundle: [{ path: "index.mjs", bytes: bytes("export default {};") }],
        vcConfig: {
          runtime: "nodejs22.x",
          handler: "index.mjs",
          launcherType: "Nodejs",
          supportsResponseStreaming: true,
        },
      });
      expect(noCron.hash).not.toEqual(artifact.hash);
    }),
  ),
);

it.live("sensitive fingerprints are stable and value-addressed", () =>
  Effect.gen(function* () {
    const one = yield* sensitiveFingerprint("s3cret");
    const two = yield* sensitiveFingerprint("s3cret");
    const other = yield* sensitiveFingerprint("different");
    expect(one).toMatch(/^alchemy:sha256:[0-9a-f]{64}$/);
    expect(one).toEqual(two);
    expect(one).not.toEqual(other);
  }),
);
