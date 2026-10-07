import { describe, expect, it } from "vitest";
import { deriveBuildSecret } from "../cli.ts";

describe("deriveBuildSecret", () => {
  it("is stable for a given root secret and label", () => {
    // Two builds that share a root secret must emit the same bytes, otherwise
    // the Worker's content hash changes on every build and every deploy
    // re-uploads it.
    expect(deriveBuildSecret("root-secret", "revalidate-secret", 32)).toBe(
      deriveBuildSecret("root-secret", "revalidate-secret", 32),
    );
  });

  it("separates labels so one build secret never reveals another", () => {
    const labels = ["rsc-build-identity", "revalidate-secret", "prerender-secret", "preview-id"];
    const values = labels.map((label) => deriveBuildSecret("root-secret", label, 32));
    expect(new Set(values).size).toBe(labels.length);
  });

  it("changes when the root secret changes", () => {
    expect(deriveBuildSecret("root-a", "revalidate-secret", 32)).not.toBe(
      deriveBuildSecret("root-b", "revalidate-secret", 32),
    );
  });

  it("returns hex of the requested byte length", () => {
    expect(deriveBuildSecret("root-secret", "preview-id", 16)).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveBuildSecret("root-secret", "prerender-secret", 32)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to random bytes when no root secret is set", () => {
    expect(deriveBuildSecret(undefined, "revalidate-secret", 32)).not.toBe(
      deriveBuildSecret(undefined, "revalidate-secret", 32),
    );
    expect(deriveBuildSecret("", "revalidate-secret", 32)).toMatch(/^[0-9a-f]{64}$/);
  });
});
