import { sha256 } from "@/Util/sha256";
import { zipCode } from "@/Util/zip";
import * as Effect from "effect/Effect";
import JSZip from "jszip";
import { expect, test } from "vitest";

test("zipCode is deterministic for identical inputs", async () => {
  const hash = () =>
    Effect.runPromise(
      zipCode("export default 1", [
        {
          path: "index.mjs.map",
          content: JSON.stringify({
            version: 3,
            sources: ["index.ts"],
          }),
        },
      ]).pipe(Effect.flatMap(sha256)),
    );

  const first = await hash();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await hash()).toBe(first);
});

test("zipCode preserves executable file permissions", async () => {
  const archive = await Effect.runPromise(
    zipCode("export default 1", [
      {
        path: "bin/ffmpeg",
        content: new Uint8Array([1, 2, 3]),
        mode: 0o755,
      },
    ]),
  );

  const zip = await JSZip.loadAsync(archive);
  expect(Number(zip.file("bin/ffmpeg")?.unixPermissions) & 0o777).toBe(0o755);
});
