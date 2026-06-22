import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

export const verifyNativePackages = async () => {
  const image = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const ffmpeg = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8" });
  return {
    architecture: process.arch,
    imageBytes: image.byteLength,
    ffmpegStatus: ffmpeg.status,
    ffmpegVersion: ffmpeg.stdout.split("\n")[0],
  };
};

export const handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(await verifyNativePackages()),
});

export default handler;
