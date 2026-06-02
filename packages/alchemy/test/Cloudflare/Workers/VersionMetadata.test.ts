import {
  isVersionMetadata,
  VersionMetadata,
} from "@/Cloudflare/Workers/VersionMetadata.ts";
import type { InferEnv } from "@/Cloudflare/Workers/InferEnv.ts";
import { describe, expect, test } from "@effect/vitest";

describe("Cloudflare.VersionMetadata", () => {
  test("creates a version metadata binding marker", () => {
    const metadata = VersionMetadata();

    expect(metadata).toEqual({ kind: "Cloudflare.VersionMetadata" });
    expect(isVersionMetadata(metadata)).toBe(true);
    expect(isVersionMetadata({ kind: "Cloudflare.VersionMetadata" })).toBe(
      true,
    );
    expect(isVersionMetadata({ type: "version_metadata" })).toBe(false);
  });

  test("maps InferEnv to the runtime WorkerVersionMetadata shape", () => {
    type Env = InferEnv<{
      CF_VERSION_METADATA: ReturnType<typeof VersionMetadata>;
    }>;

    const metadata: Env["CF_VERSION_METADATA"] = {
      id: "version-id",
      tag: "version-tag",
      timestamp: "2026-06-02T12:00:00.000Z",
    };

    expect(metadata.id).toBe("version-id");
  });
});
