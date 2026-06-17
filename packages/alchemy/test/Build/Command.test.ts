import * as AWS from "@/AWS";
import * as Build from "@/Build";
import type { ScopedPlanStatusSession } from "@/Cli/Cli.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";

const { test } = Test.make({ providers: AWS.providers() });

// A dedicated fixture (not shared with Build.test.ts): the suite mutates
// `src/main.ts` and rebuilds `dist`, and the runner executes files in parallel
// forks, so sharing a fixture across files would race on the same directory.
const fixtureDir = pathe.resolve(import.meta.dirname, "command-fixture");
const distDir = pathe.join(fixtureDir, "dist");
const mainFile = pathe.join(fixtureDir, "src", "main.ts");

// `reconcile`/`delete` only ever touch `session.note`; everything else on the
// session is unused by Build.Command, so a no-op note is a faithful stub.
const stubSession = {
  note: () => Effect.void,
} as unknown as ScopedPlanStatusSession;

test.provider(
  "list returns [] for non-listable Build.Command",
  () =>
    Effect.gen(function* () {
      // Build.Command is a local build/exec step with no remote enumeration
      // API, so list() is the non-listable pattern: always returns [].
      const provider = yield* Provider.findProvider(Build.Command);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { timeout: 30000 },
);

// All filesystem-mutating path scenarios live in one test: tests within a file
// run concurrently (vitest `sequence.concurrent`), and they all touch the same
// fixture, so they must be driven sequentially from a single body.
test.provider(
  "outdir is always persisted relative and resolves correctly across cwd shapes, rebuilds, and legacy state",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const provider = yield* Provider.findProvider(Build.Command);
      const original = yield* fs.readFileString(mainFile);

      const cleanDist = fs
        .remove(distDir, { recursive: true })
        .pipe(Effect.catch(() => Effect.void));

      const deployWith = (cwd: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Build.Command("test-build", {
              command: "bash build.sh",
              cwd,
              outdir: "dist",
            });
          }),
        );

      yield* stack.destroy();
      yield* cleanDist;

      // ── 1) Absolute cwd ──────────────────────────────────────────────────
      const fromAbsolute = yield* deployWith(fixtureDir);

      // The stored value must never be absolute — an absolute path is what made
      // state non-portable across machines (CI runner vs. local laptop) and fed
      // a stale, foreign-machine path into downstream consumers.
      expect(pathe.isAbsolute(fromAbsolute.outdir)).toBe(false);
      // ...but it must still resolve to the real output directory.
      expect(pathe.resolve(fromAbsolute.outdir)).toBe(distDir);

      yield* stack.destroy();
      yield* cleanDist;

      // ── 2) Relative cwd pointing at the same physical directory ───────────
      const relativeCwd = pathe.relative(process.cwd(), fixtureDir);
      const fromRelative = yield* deployWith(relativeCwd);

      expect(pathe.isAbsolute(fromRelative.outdir)).toBe(false);
      expect(pathe.resolve(fromRelative.outdir)).toBe(distDir);
      // However cwd is expressed, the persisted outdir is identical: it's
      // anchored to process.cwd(), not to the (variably-expressed) build cwd.
      expect(fromRelative.outdir).toBe(fromAbsolute.outdir);

      // ── 3) Rebuild on source change keeps outdir relative and put ─────────
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(
          mainFile,
          'export const message = "Updated!";\n',
        );
        const rebuilt = yield* deployWith(fixtureDir);

        // Content changed -> hash changed -> a rebuild ran...
        expect(rebuilt.hash).not.toBe(fromRelative.hash);
        // ...but the output path didn't move and is still relative.
        expect(pathe.isAbsolute(rebuilt.outdir)).toBe(false);
        expect(rebuilt.outdir).toBe(fromRelative.outdir);
        expect(pathe.resolve(rebuilt.outdir)).toBe(distDir);
      }).pipe(
        // Always restore the fixture so a failed assertion can't leave the
        // working tree dirty for the next run.
        Effect.ensuring(
          fs.writeFileString(mainFile, original).pipe(Effect.ignore),
        ),
      );

      // ── 4) Legacy absolute outdir persisted in state ──────────────────────
      // Re-deploy from a clean baseline so the live dist matches `news`.
      const baseline = yield* deployWith(fixtureDir);
      const news = {
        command: "bash build.sh",
        cwd: fixtureDir,
        outdir: "dist",
      };
      // Simulate state written by an older provider version (or another
      // machine): outdir baked as an absolute path.
      const legacyOutput = {
        outdir: pathe.resolve(baseline.outdir),
        hash: baseline.hash,
      };
      expect(pathe.isAbsolute(legacyOutput.outdir)).toBe(true);

      // read() must re-anchor the absolute path against the current cwd and
      // hand back a relative outdir — this is what stops a downstream consumer
      // (e.g. a Worker) from reading a foreign-machine path.
      const refreshed = yield* provider.read!({
        id: "test-build",
        instanceId: "legacy",
        olds: news,
        output: legacyOutput,
      });
      expect(refreshed).toBeDefined();
      expect(pathe.isAbsolute(refreshed!.outdir)).toBe(false);
      expect(pathe.resolve(refreshed!.outdir)).toBe(distDir);

      // reconcile() must treat the absolute cached artifact as reusable (hash
      // matches, directory exists) — no crash, no spurious rebuild — and still
      // converge the stored outdir to a relative path.
      const reconciled = yield* provider.reconcile({
        id: "test-build",
        instanceId: "legacy",
        news,
        olds: news,
        output: legacyOutput,
        session: stubSession,
        bindings: [],
      });
      expect(reconciled.hash).toBe(baseline.hash);
      expect(pathe.isAbsolute(reconciled.outdir)).toBe(false);
      expect(pathe.resolve(reconciled.outdir)).toBe(distDir);

      // delete() must resolve the absolute outdir and remove the directory.
      yield* provider.delete({
        id: "test-build",
        instanceId: "legacy",
        olds: news,
        output: legacyOutput,
        session: stubSession,
        bindings: [],
      });
      expect(yield* fs.exists(distDir)).toBe(false);

      yield* stack.destroy();
    }),
  { timeout: 120000 },
);
