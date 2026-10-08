import { describe, expect, it } from "alchemy-test";
import {
  foldkitAssetsFromManifest,
  foldkitBuildMetadataReader,
  type FoldkitBuildManifest,
  type FoldkitBuildMetadata,
} from "@/Cloudflare/Website/FoldkitBuild";

const manifest = (prerendered: ReadonlyArray<string>): FoldkitBuildManifest => ({
  schemaVersion: 1,
  client: "dist/client",
  server: "dist/server",
  serverEntry: "fetch.js",
  prerendered,
});

const metadata = (): FoldkitBuildMetadata => ({
  root: "/project",
  clientDirectory: "/project/dist/client",
  serverDirectory: "/project/dist/server",
  serverEntry: "/project/dist/server/fetch.js",
  manifest: manifest(["/about"]),
});

describe(
  "foldkitAssetsFromManifest",
  {
    tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:website"],
  },
  () => {
    it("gives a client-only build the single-page-application fallback", () => {
      expect(foldkitAssetsFromManifest(undefined)).toEqual({
        notFoundHandling: "single-page-application",
      });
    });

    it("derives nothing for a server-rendered build", () => {
      expect(foldkitAssetsFromManifest(manifest([]))).toBeUndefined();
    });

    it("derives nothing for a prerendered build", () => {
      expect(foldkitAssetsFromManifest(manifest(["/", "/about"]))).toBeUndefined();
    });
  },
);

describe(
  "foldkitBuildMetadataReader",
  {
    tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:website"],
  },
  () => {
    it("allows a client-only app with a custom Worker entry", () => {
      expect(foldkitBuildMetadataReader([], "src/worker.ts")).toBeUndefined();
    });

    it("reads metadata only when called after the full build", () => {
      let complete = false;
      const read = foldkitBuildMetadataReader(
        [
          {
            name: "foldkit:build",
            api: {
              getBuildMetadata() {
                if (!complete) throw new Error("Build is incomplete");
                return metadata();
              },
            },
          },
        ],
        undefined,
      );
      expect(() => read!()).toThrow("Build is incomplete");
      complete = true;
      expect(read!()).toEqual(metadata());
    });

    it("refuses an older build plugin instead of assuming SPA routing", () => {
      expect(() =>
        foldkitBuildMetadataReader(
          [
            {
              name: "foldkit:build",
              api: { serverEntry: "/src/entry.server.ts" },
            },
          ],
          undefined,
        ),
      ).toThrow("Upgrade @foldkit/vite-plugin");
    });

    it("rejects a conflicting main before the build starts", () => {
      expect(() => foldkitBuildMetadataReader([{ name: "foldkit:build" }], "src/fetch.ts")).toThrow(
        "cannot be combined with main",
      );
    });

    for (const [label, invalid] of Object.entries({
      missing: undefined,
      incomplete: { ...metadata(), serverEntry: undefined },
      "unknown manifest version": {
        ...metadata(),
        manifest: { ...manifest([]), schemaVersion: 2 },
      },
    })) {
      it(`rejects incompatible metadata: ${label}`, () => {
        const read = foldkitBuildMetadataReader(
          [{ name: "foldkit:build", api: { getBuildMetadata: () => invalid } }],
          undefined,
        );
        expect(() => read!()).toThrow();
      });
    }
  },
);
