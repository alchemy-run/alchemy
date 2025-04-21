import alchemy from "../../alchemy/src";
import { NuxtSite, Pipeline, R2Bucket } from "../../alchemy/src/cloudflare";

const R2_BUCKET_NAME = "example-bucket";
const PIPELINE_NAME = "example-pipeline";

const app = await alchemy("app", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: !process.argv.includes("--verbose"),
  password: process.env.ALCHEMY_PASS,
});

const bucket = await R2Bucket("bucket", {
  name: R2_BUCKET_NAME,
});

const pipeline = await Pipeline("pipeline", {
  name: PIPELINE_NAME,
  source: [{ type: "binding", format: "json" }],
  destination: {
    type: "r2",
    format: "json",
    path: {
      bucket: bucket.name,
    },
    credentials: {
      accessKeyId: alchemy.secret(process.env.R2_ACCESS_KEY_ID),
      secretAccessKey: alchemy.secret(process.env.R2_SECRET_ACCESS_KEY),
    },
    batch: {
      maxMb: 10,
      // testing value. recommended - 300
      maxSeconds: 5,
      maxRows: 100,
    },
  },
});

export const website = await NuxtSite("website", {
  command: "bun run build",
  // Nuxt outputs server to .output/server/index.mjs with cloudflare-module preset
  main: "./index.ts",
  // Nuxt outputs static assets to .output/public
  assets: "./.output/public/",
  bindings: {
    R2_BUCKET: bucket,
    PIPELINE: pipeline,
  },
});

console.log({
  url: website.url,
});

await app.finalize(); // must be at end
