import { uploadedWorkerVersionId } from "@alchemy.run/cloudflare/Workers/WorkerProvider";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

const versionId = "51a15706-27d3-4705-acf3-c494388c9b14";

describe(
  "Cloudflare.Worker upload receipt",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker"] },
  () => {
    for (const receipt of [
      versionId,
      versionId.replaceAll("-", ""),
      versionId.toUpperCase(),
      versionId.replaceAll("-", "").toUpperCase(),
    ]) {
      it.effect(`normalizes ${receipt}`, () =>
        Effect.gen(function* () {
          expect(yield* uploadedWorkerVersionId(receipt, "receipt-worker")).toBe(versionId);
        }),
      );
    }

    for (const receipt of [
      undefined,
      null,
      "",
      "not-a-uuid",
      "a".repeat(31),
      "g".repeat(32),
      "-".repeat(36),
      ` ${versionId}`,
      `${versionId}\n`,
    ]) {
      it.effect(`rejects invalid receipt ${JSON.stringify(receipt)}`, () =>
        Effect.gen(function* () {
          const error = yield* uploadedWorkerVersionId(receipt, "receipt-worker").pipe(Effect.flip);
          expect(error._tag).toBe("WorkerVersionConfigError");
          expect(error.message).toContain("receipt-worker");
          expect(error.message).toContain("valid upload version receipt");
        }),
      );
    }
  },
);
