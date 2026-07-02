import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Enforcement for provider metadata (see processes/ProviderMetadata/DESIGN.md
 * §6): every resource provider under src/AWS and src/Cloudflare must declare a
 * `metadata` field — local-only providers declare `metadata: {}` — so the
 * credential-requirements catalog can't rot as new resources are added.
 *
 * Static source scan (counting `Provider.effect(`/`Provider.succeed(` sites
 * vs `metadata: {` keys per file) rather than constructing the provider
 * layers, which would require cloud environment services in a unit test.
 */

const PROVIDER_CALL = /\bProvider\.(effect|succeed)\(/g;
const METADATA_KEY = /\bmetadata: \{/g;

const scan = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(import.meta.dirname, "..", "src");

  const offenders: string[] = [];
  for (const cloud of ["AWS", "Cloudflare"]) {
    const files = yield* fs.readDirectory(path.join(root, cloud), {
      recursive: true,
    });
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const source = yield* fs.readFileString(path.join(root, cloud, file));
      const providers = source.match(PROVIDER_CALL)?.length ?? 0;
      if (providers === 0) continue;
      const metadata = source.match(METADATA_KEY)?.length ?? 0;
      if (metadata < providers) {
        offenders.push(
          `${cloud}/${file} (${providers} provider(s), ${metadata} metadata key(s))`,
        );
      }
    }
  }
  return offenders;
});

describe("ProviderMetadata", () => {
  it.effect(
    "every AWS and Cloudflare resource provider declares metadata",
    () =>
      Effect.gen(function* () {
        const offenders = yield* scan;
        expect(
          offenders,
          "providers missing a metadata field — annotate them per processes/ProviderMetadata/DESIGN.md " +
            "(local-only providers declare `metadata: {}`)",
        ).toEqual([]);
      }).pipe(Effect.provide(PlatformServices)),
  );
});
