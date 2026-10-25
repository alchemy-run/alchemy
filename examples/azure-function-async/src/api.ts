import type { ApiEnv } from "../alchemy.run.ts";

/**
 * - `GET /` answers the greeting
 * - `PUT /notes/:name` stores the request body as a blob
 * - `GET /notes/:name` reads it back
 */
export default {
  async fetch(request: Request, env: ApiEnv) {
    const url = new URL(request.url);
    const [, collection, name] = url.pathname.split("/");

    if (collection === "notes" && name) {
      const blobUrl = `https://${env.NOTES.storageAccount}.blob.core.windows.net/${env.NOTES.containerName}/${encodeURIComponent(name)}`;
      const headers = {
        authorization: `Bearer ${await storageToken()}`,
        "x-ms-version": "2023-11-03",
      };

      if (request.method === "PUT") {
        const res = await fetch(blobUrl, {
          method: "PUT",
          headers: { ...headers, "x-ms-blob-type": "BlockBlob", "content-type": "text/plain" },
          body: await request.text(),
        });
        return new Response(res.ok ? "stored" : await res.text(), {
          status: res.ok ? 201 : res.status,
        });
      }

      if (request.method === "GET") {
        const res = await fetch(blobUrl, { headers });
        if (res.status === 404) return new Response("Not Found", { status: 404 });
        return new Response(await res.text(), { status: res.status });
      }
    }

    if (url.pathname === "/") {
      return new Response(`${env.GREETING} from Azure Functions`);
    }

    return new Response("Not Found", { status: 404 });
  },
};

let cached: { token: string; expiresAt: number } | undefined;

/**
 * A token for Azure Storage from the app's managed identity, through the
 * identity endpoint the Functions host sets in `IDENTITY_ENDPOINT`.
 */
async function storageToken(): Promise<string> {
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
  const endpoint = new URL(process.env.IDENTITY_ENDPOINT!);
  endpoint.searchParams.set("resource", "https://storage.azure.com/");
  endpoint.searchParams.set("api-version", "2019-08-01");
  const res = await fetch(endpoint, {
    headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER! },
  });
  if (!res.ok) throw new Error(`identity endpoint answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_on: string };
  cached = { token: body.access_token, expiresAt: Number(body.expires_on) * 1000 };
  return cached.token;
}
