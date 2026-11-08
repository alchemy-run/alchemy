import { makeEffectVirtualEntry } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import { describe, expect, it } from "@alchemy.run/test";

const stack = { name: "effect-virtual-entry-unit", stage: "test" };

describe("Effect virtual entry", { tags: ["unit", "provider:cloudflare", "local"] }, () => {
  it("re-exports named entrypoints from their modules", () => {
    const entry = makeEffectVirtualEntry({}, stack, {
      Echo: "./echo.ts",
      WorkspaceProxy: "@cloudflare/computer",
    })("/project/src/worker.ts");

    // A relative module resolves from the Worker's `main`, a package as written.
    expect(entry).toContain('export { Echo } from "/project/src/echo.ts";');
    expect(entry).toContain('export { WorkspaceProxy } from "@cloudflare/computer";');
  });

  it("exports no named entrypoint by default", () => {
    const entry = makeEffectVirtualEntry({}, stack)("/project/src/worker.ts");

    expect(entry).not.toMatch(/^export \{ \w+ \} from/m);
  });
});
