import { checkSuitesChanged, serviceCheckSuites } from "@alchemy.run/railway/ServiceChecks";
import { describe, expect, it } from "@alchemy.run/test";

describe(
  "Railway service wait for CI",
  { tags: ["unit", "provider:railway", "provider:railway:service", "local"] },
  () => {
    it("reads source.checkSuites and treats an absent key as off", () => {
      const config = {
        services: {
          on: { source: { repo: "acme/web", checkSuites: true } },
          off: { source: { repo: "acme/web", checkSuites: false } },
          unset: { source: { repo: "acme/web" } },
          image: { source: { image: "hashicorp/http-echo" } },
        },
      };
      expect(serviceCheckSuites(config, "on")).toBe(true);
      expect(serviceCheckSuites(config, "off")).toBe(false);
      expect(serviceCheckSuites(config, "unset")).toBe(false);
      expect(serviceCheckSuites(config, "image")).toBe(false);
      expect(serviceCheckSuites(config, "missing")).toBe(false);
      expect(serviceCheckSuites(undefined, "on")).toBe(false);
      expect(serviceCheckSuites({ services: [] }, "on")).toBe(false);
    });

    it("writes only when the desired value differs", () => {
      expect(checkSuitesChanged(undefined, true)).toBe(false);
      expect(checkSuitesChanged(undefined, false)).toBe(false);
      expect(checkSuitesChanged(true, true)).toBe(false);
      expect(checkSuitesChanged(false, false)).toBe(false);
      expect(checkSuitesChanged(true, false)).toBe(true);
      expect(checkSuitesChanged(false, true)).toBe(true);
    });
  },
);
