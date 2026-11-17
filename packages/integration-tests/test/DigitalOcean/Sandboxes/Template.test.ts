import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getMicrovm, getMicrovmCheckpoint, runMicrovmCommand } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:sandboxes", "live"];
const LIVE_TIMEOUT = 600_000;

test.provider(
  "template and sandbox: build a base from an image, start a sandbox from it, destroy both",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const base = yield* DigitalOcean.Sandboxes.Template("Base", {
            image: "alpine:3.20",
            setup: ["echo built-by-template > /etc/alchemy-marker"],
          });
          const sandbox = yield* DigitalOcean.Sandboxes.Sandbox("Box", { base });
          return { base, sandbox };
        }),
      );
      expect(deployed.base.checkpointId).toBeTruthy();
      expect(deployed.sandbox.state).toEqual("running");

      // The sandbox starts from the template's disk.
      const marker = yield* runMicrovmCommand({
        microvm_id: deployed.sandbox.sandboxId,
        argv: ["cat", "/etc/alchemy-marker"],
      });
      expect(marker.stdout.trim()).toEqual("built-by-template");

      yield* stack.destroy();

      expect(yield* isGone(getMicrovm({ microvm_id: deployed.sandbox.sandboxId }))).toBe(true);
      expect(
        yield* isGone(getMicrovmCheckpoint({ checkpoint_id: deployed.base.checkpointId })),
      ).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
