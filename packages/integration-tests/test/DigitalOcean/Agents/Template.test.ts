import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getHarnessTemplate } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, skipSlow } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:agents", "live"];

// A build pulls and converts the image: several minutes.
test.provider.skipIf(skipSlow)(
  "template: build a sandbox image on a base template, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        DigitalOcean.Agents.Template("Tools", {
          baseTemplate: "coding-base",
          image: "docker.io/library/debian:bookworm-slim",
        }),
      );
      expect(created.status).toEqual("TEMPLATE_STATUS_READY");
      yield* stack.destroy();
      expect(yield* isGone(getHarnessTemplate({ template_id: created.templateId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 1_800_000 },
);
