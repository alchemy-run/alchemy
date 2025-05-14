import { alchemy } from "../../src/alchemy.js";
import {
  Pipeline,
  Queue,
  R2Bucket,
  Worker,
} from "../../src/cloudflare/index.js";

const app = await alchemy("my-app");

const queue = await Queue<R2Object>("queue");

const bucket = await R2Bucket("bucket");

const pipeline = await Pipeline<R2Object>("pipeline", {
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

export default Worker("worker", {
  async fetch(request) {
    const key = new URL(request.url).pathname;
    const obj = await bucket.put(key, request.body);
    if (!obj) {
      return new Response("Failed to upload object", { status: 500 });
    }
    await queue.send(obj);
    await pipeline.send([obj]);
    return new Response(
      JSON.stringify({
        key: obj.key,
        etag: obj.etag,
      }),
    );
  },
});

await app.finalize();
