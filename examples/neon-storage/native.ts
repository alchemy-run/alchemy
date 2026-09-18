import { AwsClient } from "aws4fetch";

const s3 = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  region: process.env.AWS_REGION!,
  service: "s3",
});

export default {
  async fetch(request: Request) {
    if (
      !process.env.APP_TOKEN ||
      request.headers.get("authorization") !== `Bearer ${process.env.APP_TOKEN}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    const path = new URL(request.url).pathname;
    const endpoint = process.env.AWS_ENDPOINT_URL_S3!.replace(/\/$/, "");
    const objectUrl = `${endpoint}/${encodeURIComponent(process.env.UPLOADS_BUCKET!)}/incoming/native.txt`;
    if (path === "/upload-url") {
      const url = new URL(objectUrl);
      url.searchParams.set("X-Amz-Expires", "300");
      const signed = await s3.sign(url, {
        method: "PUT",
        aws: { signQuery: true },
      });
      return Response.json({ url: signed.url });
    }
    if (request.method === "PUT") {
      return s3.fetch(objectUrl, {
        method: "PUT",
        body: await request.arrayBuffer(),
        headers: { "content-type": "text/plain" },
      });
    }
    return s3.fetch(objectUrl);
  },
};
