import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  assertSiteGone,
  cloudflareFixture,
  cloudRunUrl,
  liveOptions,
  logLevel,
  serviceIdentity,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "StaticSite: build v1, rebuild to v2 in place, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* cloneFixture(cloudflareFixture("staticsite-fixture"), {
        prefix: "alchemy-staticsite-gcp-",
        tempRoot,
        entries: ["src", "build.sh"],
      });
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const site = yield* GCP.Website.StaticSite("Blog", {
              path: cwd,
              build: { command: "bash build.sh", output: "dist" },
              memo: { include: ["src/**", "build.sh"] },
              env: { SITE_MODE: "blog", SITE_TOKEN: Redacted.make("site-s3cret") },
            });
            return { site };
          }),
        );

      const first = yield* deploy();
      const url = first.site.url as string;
      expect(url).toMatch(cloudRunUrl);
      const service = serviceIdentity(first.site.service!);
      yield* expectUrlContains(`${url}/`, "StaticSite fixture v1", {
        timeout: "180 seconds",
        label: "static v1",
      });

      // A `Redacted` env value is read from Secret Manager; the revision
      // never holds it.
      const deployed = yield* cloudrun.getProjectsLocationsServices({
        name: first.site.service!.name,
      });
      const env = deployed.template?.containers?.[0]?.env ?? [];
      const token = env.find((entry) => entry.name === "SITE_TOKEN");
      expect(token?.value).toBeUndefined();
      expect(token?.valueSource?.secretKeyRef?.secret).toMatch(
        /^alch-[0-9a-f]{12}-main-SITE_TOKEN$/,
      );
      expect(JSON.stringify(deployed.template)).not.toContain("site-s3cret");
      expect(env.find((entry) => entry.name === "SITE_MODE")?.value).toBe("blog");

      const index = path.join(cwd, "src/index.html");
      yield* fs.writeFileString(
        index,
        (yield* fs.readFileString(index)).replaceAll("fixture v1", "fixture v2"),
      );
      const second = yield* deploy();
      expect(second.site.url).toBe(url);
      expect(second.site.service!.codeHash).not.toBe(first.site.service!.codeHash);
      yield* expectUrlContains(`${url}/`, "StaticSite fixture v2", {
        timeout: "60 seconds",
        label: "static v2",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(1_200_000),
);
