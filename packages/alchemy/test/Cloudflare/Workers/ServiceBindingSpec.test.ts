import { isServiceBindingSpec } from "@/Cloudflare/Workers/WorkerBinding.ts";
import { describe, expect, it } from "alchemy-test";

// `isServiceBindingSpec` is the discriminator that routes a raw
// `{ $binding: "service", ... }` env entry to the entrypoint-capable service
// binding branch in `toBinding`. A pure guard — no cloud credentials needed.
describe("isServiceBindingSpec", () => {
  it("matches a bare service spec", () => {
    expect(isServiceBindingSpec({ $binding: "service", service: "api" })).toBe(
      true,
    );
  });

  it("matches a spec carrying entrypoint and environment", () => {
    expect(
      isServiceBindingSpec({
        $binding: "service",
        service: "billing-worker",
        entrypoint: "BillingRpc",
        environment: "production",
      }),
    ).toBe(true);
  });

  it("rejects a spec without a service name", () => {
    expect(isServiceBindingSpec({ $binding: "service" })).toBe(false);
  });

  it("rejects a different $binding discriminant", () => {
    expect(isServiceBindingSpec({ $binding: "kv", service: "api" })).toBe(
      false,
    );
  });

  it("rejects non-object values", () => {
    expect(isServiceBindingSpec(null)).toBe(false);
    expect(isServiceBindingSpec(undefined)).toBe(false);
    expect(isServiceBindingSpec("api")).toBe(false);
  });
});
