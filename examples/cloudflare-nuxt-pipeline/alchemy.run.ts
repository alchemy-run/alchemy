import alchemy from "alchemy";
import { Nuxt, Pipeline, R2Bucket } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-nuxt-pipeline");

const bucket = await R2Bucket("bucket", {
  name: `${app.name}-${app.stage}-bucket`,
  adopt: true,
});

const pipeline = await Pipeline("pipeline", {
  name: `${app.name}-${app.stage}-pipeline`,
  adopt: true,
  source: [{ type: "binding", format: "json" }],
  destination: {
    type: "r2",
    format: "json",
    path: { bucket: bucket.name },
    credentials: {
      accessKeyId: alchemy.secret(process.env.R2_ACCESS_KEY_ID),
      secretAccessKey: alchemy.secret(process.env.R2_SECRET_ACCESS_KEY),
    },
    batch: {
      maxMb: 10, // testing value. recommended - 300       maxSeconds: 5,       maxRows: 100,
    },
  },
});

export const website = await Nuxt("website", {
  name: `${app.name}-${app.stage}-website`,
  adopt: true,
  bindings: {
    R2_BUCKET: bucket,
    PIPELINE: pipeline,
  },
});

console.log({
  url: website.url,
});

await app.finalize(); // must be at end
