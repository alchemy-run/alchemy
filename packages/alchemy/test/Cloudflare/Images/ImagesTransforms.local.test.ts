import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "node:path";
import ImagesTextWorker from "./fixtures/text-effect-worker.ts";
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "local Images transforms ordered pixels, fits, overlays and output encodings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const effectWorker = yield* ImagesTextWorker;
          const worker = yield* Cloudflare.Worker("images-transform-local", {
            main: Path.resolve(
              import.meta.dirname,
              "fixtures/transforms-worker.ts",
            ),
            env: { IMAGES: Cloudflare.Images.Images("IMAGES") },
          });
          return { worker, effectWorker };
        }),
      );
      const { worker, effectWorker } = deployed;
      yield* Effect.promise(async () => {
        const fetchReady = async (url: string, init?: RequestInit) => {
          for (let attempt = 0; ; attempt++) {
            const response = await fetch(url, init);
            if (response.status !== 503 || attempt === 8) return response;
            await response.arrayBuffer();
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        };
        const transform = async (props: unknown) => {
          const response = await fetchReady(worker.url!, {
            method: "POST",
            body: JSON.stringify(props),
          });
          if (!response.ok) throw new Error(await response.text());
          return new Uint8Array(await response.arrayBuffer());
        };
        const effectResponse = await fetchReady(
          `${effectWorker.url}?font=${encodeURIComponent(`${worker.url}/font`)}`,
        );
        expect(effectResponse.status).toBe(200);
        const effectText = new Uint8Array(await effectResponse.arrayBuffer());
        expect(effectText.length).toBeGreaterThan(0);
        expect(
          [...effectText].some(
            (value, index) => index % 4 === 1 && value === 255,
          ),
        ).toBe(true);
        const rgb = { format: "rgb" };
        expect(
          (
            await transform({
              transforms: [{ width: 4, height: 4, fit: "contain" }],
              output: rgb,
            })
          ).length,
        ).toBe(4 * 2 * 3);
        const pad = await transform({
          transforms: [{ width: 4, height: 4, fit: "pad", background: "blue" }],
          output: rgb,
        });
        expect(pad.length).toBe(4 * 4 * 3);
        expect([...pad.slice(0, 3)]).toEqual([0, 0, 255]);
        const overlay = await transform({ draw: true, output: rgb });
        expect([...overlay.slice(0, 3)]).toEqual([255, 0, 0]);
        expect([...overlay.slice((8 + 1) * 3, (8 + 2) * 3)]).toEqual([
          0, 0, 255,
        ]);
        // The second resize scales the first one's rotated result; keeping only
        // the final Sharp resize would produce a different byte count.
        const ordered = await transform({
          transforms: [{ width: 4 }, { rotate: 90 }, { width: 1 }],
          output: rgb,
        });
        expect(ordered.length).toBe(1 * 2 * 3);
        const gif = await transform({ output: { format: "image/gif" } });
        expect(new TextDecoder().decode(gif.slice(0, 3))).toBe("GIF");
        const rgba = await transform({
          transforms: [{ width: 2 }],
          output: { format: "rgba" },
        });
        expect(rgba.length).toBe(2 * 1 * 4);
        expect([...rgba.slice(0, 4)]).toEqual([255, 0, 0, 255]);
        const text = await transform({
          source: "text",
          output: { format: "rgba" },
        });
        expect(text.length).toBeGreaterThan(0);
        let opaque = 0;
        for (let i = 0; i < text.length; i += 4)
          if (text[i + 3]! > 0) {
            opaque++;
            expect([...text.slice(i, i + 3)]).toEqual([0, 255, 0]);
          }
        expect(opaque).toBeGreaterThan(20);
        const mixed = await transform({
          draw: true,
          textDraw: true,
          output: { format: "rgba" },
        });
        expect(mixed.length).toBe(8 * 4 * 4);
        expect(
          [...mixed].some((value, index) => index % 4 === 1 && value > 0),
        ).toBe(true);
        expect([...mixed.slice((8 + 1) * 4, (8 + 2) * 4)]).toEqual([
          0, 0, 255, 255,
        ]);
        const animated = await transform({
          source: "animated",
          transforms: [{ width: 2 }],
          output: { format: "image/gif" },
        });
        expect(inspectGif(animated)).toEqual({
          width: 2,
          height: 1,
          frames: 2,
          delays: [100, 200],
        });
        const still = await transform({
          source: "animated",
          output: { format: "image/gif", anim: false },
        });
        expect(inspectGif(still).frames).toBe(1);
      });
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

function inspectGif(bytes: Uint8Array) {
  const word = (offset: number) => bytes[offset]! + bytes[offset + 1]! * 256;
  let offset = 13 + (bytes[10]! & 128 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
  let frames = 0;
  const delays: number[] = [];
  const skipBlocks = () => {
    while (bytes[offset]) offset += bytes[offset]! + 1;
    offset++;
  };
  while (offset < bytes.length) {
    const kind = bytes[offset++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const extension = bytes[offset++];
      if (extension === 0xf9) delays.push(word(offset + 2) * 10);
      skipBlocks();
    } else if (kind === 0x2c) {
      frames++;
      const packed = bytes[offset + 8]!;
      offset += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      offset++; // LZW minimum code size
      skipBlocks();
    } else throw new Error("Malformed GIF output");
  }
  return { width: word(6), height: word(8), frames, delays };
}
