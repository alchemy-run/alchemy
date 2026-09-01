import { AuthProviders } from "@/Auth/AuthProvider.ts";
import {
  PROFILE_MANIFEST_VERSION,
  ProfileStore,
  ProfileStoreLive,
} from "@/Auth/Profile.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import path from "pathe";

const FIXTURE_HOME = path.join(import.meta.dirname, "fixtures/v0-home");

const testLayer = () =>
  ProfileStoreLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        ConfigProvider.layer(ConfigProvider.fromUnknown({})),
        NodeServices.layer,
      ),
    ),
  );

/**
 * Point `ALCHEMY_HOME` at a scoped temp directory seeded from a fixture
 * tree, so store operations never touch the developer's real `~/.alchemy`.
 * Tests using this must be `exclusive` — the env var is process-global.
 */
const withFixtureHome = <A, E, R>(
  fixture: string | undefined,
  effect: (home: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-migrate-",
    });
    if (fixture !== undefined) {
      yield* fs.copyFile(
        path.join(fixture, "profiles.json"),
        path.join(dir, "profiles.json"),
      );
      yield* fs.copy(
        path.join(fixture, "credentials"),
        path.join(dir, "credentials"),
      );
    }
    const previous = process.env.ALCHEMY_HOME;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.ALCHEMY_HOME = dir;
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.ALCHEMY_HOME;
          else process.env.ALCHEMY_HOME = previous;
        }),
    );
    return yield* effect(dir);
  }).pipe(Effect.scoped, Effect.provide(testLayer()));

it.live(
  "migrates a full v0 store: entries kept, credentials dropped into a backup",
  () =>
    withFixtureHome(FIXTURE_HOME, (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ProfileStore;

        // The first read performs the on-disk migration.
        const manifest = yield* store.readManifest;

        // Every profile and provider entry survives (ids backfilled from the
        // profile name), except legacy `method: "env"` entries.
        expect(Object.keys(manifest.profiles).sort()).toEqual([
          "default",
          "work",
        ]);
        expect(manifest.profiles.default?.id).toBe("default");
        expect(manifest.profiles.work?.id).toBe("work");
        expect(manifest.profiles.default?.providers.Cloudflare?.method).toBe(
          "oauth",
        );
        expect(manifest.profiles.default?.providers.AWS?.method).toBe("sso");
        expect(manifest.profiles.default?.providers.Neon).toBeUndefined();
        expect(manifest.profiles.work?.providers.GitHub?.method).toBe("stored");
        expect(manifest.profiles.work?.providers.Axiom?.method).toBe("stored");
        expect(manifest.profiles.work?.providers.Cloudflare?.method).toBe(
          "stored",
        );

        // The manifest on disk is upgraded in place, keeping provider
        // details like the SSO profile and OAuth scopes.
        const onDisk = JSON.parse(
          yield* fs.readFileString(path.join(home, "profiles.json")),
        );
        expect(onDisk.version).toBe(PROFILE_MANIFEST_VERSION);
        expect(onDisk.profiles.work.id).toBe("work");
        expect(onDisk.profiles.default.providers.AWS.ssoProfile).toBe("dev");
        expect(onDisk.profiles.default.providers.Cloudflare.scopes).toEqual([
          "account:read",
          "workers:write",
        ]);
        expect(onDisk.profiles.default.providers.Neon).toBeUndefined();

        // The original manifest and every credential file are preserved in
        // a timestamped backup for manual recovery.
        const backups = (yield* fs.readDirectory(home)).filter((entry) =>
          entry.startsWith(".v0-profiles-"),
        );
        expect(backups).toHaveLength(1);
        const backupDir = path.join(home, backups[0]!);
        const backedUp = JSON.parse(
          yield* fs.readFileString(path.join(backupDir, "profiles.json")),
        );
        expect(backedUp.version).toBe(0);
        // v0 profiles are flat provider maps (no `providers` wrapper).
        expect(backedUp.profiles.default.Neon.method).toBe("env");
        const oauth = JSON.parse(
          yield* fs.readFileString(
            path.join(backupDir, "credentials/default/cf-oauth.json"),
          ),
        );
        expect(oauth.refresh).toBe("v0-refresh-token");
        for (const file of [
          "credentials/default/cloudflare-state-store.json",
          "credentials/work/gh-stored.json",
          "credentials/work/axiom-stored.json",
          "credentials/work/cf-stored.json",
        ]) {
          expect(yield* fs.exists(path.join(backupDir, file))).toBe(true);
        }

        // The live credential store is empty — providers report a clean
        // "not configured" instead of loading stale v0 secrets.
        expect(yield* fs.exists(path.join(home, "credentials/default"))).toBe(
          false,
        );
        expect(yield* fs.exists(path.join(home, "credentials/work"))).toBe(
          false,
        );

        // Idempotent: a second read is a plain current-version read — no new
        // backup dir, and the existing one is untouched.
        const again = yield* store.readManifest;
        expect(again.profiles.work?.providers.GitHub?.method).toBe("stored");
        expect(
          (yield* fs.readDirectory(home)).filter((entry) =>
            entry.startsWith(".v0-profiles-"),
          ),
        ).toHaveLength(1);
        expect(
          JSON.parse(
            yield* fs.readFileString(path.join(backupDir, "profiles.json")),
          ).version,
        ).toBe(0);
      }),
    ),
  { exclusive: true },
);

it.live(
  "leaves a current-version store untouched (no backup, credentials kept)",
  () =>
    withFixtureHome(undefined, (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          path.join(home, "profiles.json"),
          JSON.stringify({
            version: PROFILE_MANIFEST_VERSION,
            profiles: {
              default: { id: "default", providers: {} },
              work: {
                id: "work-id",
                providers: { Neon: { method: "stored" } },
              },
            },
          }),
        );
        yield* fs.makeDirectory(path.join(home, "credentials/work"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(home, "credentials/work/neon-stored.json"),
          JSON.stringify({ apiKey: "current-key" }),
        );

        const store = yield* ProfileStore;
        const manifest = yield* store.readManifest;

        expect(manifest.profiles.work?.id).toBe("work-id");
        expect(
          (yield* fs.readDirectory(home)).filter((entry) =>
            entry.startsWith(".v0-profiles-"),
          ),
        ).toHaveLength(0);
        expect(
          yield* fs.exists(
            path.join(home, "credentials/work/neon-stored.json"),
          ),
        ).toBe(true);
      }),
    ),
  { exclusive: true },
);
