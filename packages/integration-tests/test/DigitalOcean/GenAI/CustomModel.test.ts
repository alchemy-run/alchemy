import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getGenaiCustomModel } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { logLevel, skipSlow } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:genai", "live"];

// A small public instruct model DigitalOcean supports (≈ 1 GB).
const REPO = "Qwen/Qwen2.5-0.5B-Instruct";

test.provider.skipIf(skipSlow)(
  "custom model: import from Hugging Face, update metadata in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const declare = (description: string, tags: string[]) =>
        DigitalOcean.GenAI.CustomModel("Smol", {
          source: { huggingFace: REPO },
          description,
          tags,
        });

      const created = yield* stack.deploy(declare("first", ["a"]));
      expect(created.status).toEqual("STATUS_READY");
      const remote = yield* getGenaiCustomModel({ uuid: created.customModelId });
      expect(remote.model).toMatchObject({
        description: "first",
        source_ref: { repo_id: REPO },
      });

      const updated = yield* stack.deploy(declare("second", ["a", "b"]));
      expect(updated.customModelId).toEqual(created.customModelId);
      const after = yield* getGenaiCustomModel({ uuid: created.customModelId });
      expect(after.model?.description).toEqual("second");
      expect([...(after.model?.tags?.tags ?? [])].sort()).toEqual(["a", "b"]);

      yield* stack.destroy();
      const status = yield* getGenaiCustomModel({ uuid: created.customModelId }).pipe(
        Effect.map((r) => r.model?.status ?? "gone"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
      );
      expect(["gone", "STATUS_DELETED"]).toContain(status);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 1_200_000 },
);
