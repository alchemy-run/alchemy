import type { NotesEnv } from "./resources.ts";

/**
 * A plain `fetch` handler. A Function's image runs bun, so `Bun.S3Client` is there
 * with no dependency, and nothing here needs Effect.
 *
 * - `GET /` returns `GREETING`.
 * - `PUT /notes/:id` stores the request body.
 * - `GET /notes/:id` returns it, or `404`.
 */
export default {
  async fetch(request: Request, env: NotesEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response(env.GREETING);
    }

    const [section, id] = pathname.split("/").filter(Boolean);
    if (section !== "notes" || id === undefined) {
      return new Response("not found", { status: 404 });
    }

    const note = new Bun.S3Client({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    }).file(`notes/${decodeURIComponent(id)}`);

    if (request.method === "PUT") {
      await note.write(await request.text());
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      return (await note.exists())
        ? new Response(await note.text())
        : new Response("no such note", { status: 404 });
    }
    return new Response("method not allowed", { status: 405 });
  },
};
