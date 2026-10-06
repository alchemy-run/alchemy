import { browserProfileDir, rootDir } from "@/Auth/Paths.ts";
import * as Browser from "@/Browser.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

describe("browserProfileDir", { tags: ["unit", "local"] }, () => {
  it("nests named profiles under the alchemy home browser directory", () => {
    expect(browserProfileDir("default")).toBe(`${rootDir()}/browser/default`);
  });
});

describe("Browser.layer", { tags: ["unit", "local"] }, () => {
  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "fails with BrowserUnavailable when the channel cannot be launched",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectory({
            prefix: "alchemy-browser-test-",
          });
          const profileDir = path.join(root, "profile");
          const result = yield* Browser.Browser.use((browser) =>
            browser.withPage("about:blank", async () => "unreachable"),
          ).pipe(
            Effect.provide(Browser.layer({ profileDir, channel: "msedge" })),
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("BrowserUnavailable");
            expect(result.failure.message).toContain("msedge");
            expect(result.failure.message).toContain("playwright-core");
          }
          const info = yield* fs.stat(profileDir);
          expect(info.type).toBe("Directory");
          yield* fs.remove(root, { recursive: true });
        }),
      { timeout: 30_000 },
    );
  });
});
