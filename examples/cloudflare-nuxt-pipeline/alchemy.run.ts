import alchemy from "alchemy";
import { DOStateStore, Nuxt, Pipeline, R2Bucket } from "alchemy/cloudflare";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";

const app = await alchemy("cloudflare-nuxt-pipeline", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: !process.argv.includes("--verbose"),
  password: process.env.SECRET_PASSPHRASE,
  stateStore:
    process.env.ALCHEMY_STATE_STORE === "cloudflare"
      ? (scope) => new DOStateStore(scope)
      : undefined,
});

const bucket = await R2Bucket(
  `cloudflare-nuxt-pipeline-bucket${BRANCH_PREFIX}`,
);

const pipeline = await Pipeline(
  `cloudflare-nuxt-pipeline-pipeline${BRANCH_PREFIX}`,
  {
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
  },
);

export const website = await Nuxt(
  `cloudflare-nuxt-pipeline-website${BRANCH_PREFIX}`,
  {
    bindings: {
      R2_BUCKET: bucket,
      PIPELINE: pipeline,
    },
  },
);

console.log({
  url: website.url,
});

await app.finalize(); // must be at end
