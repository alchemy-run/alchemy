/// <reference types="@cloudflare/workers-types" />
export default {
  async fetch(request: Request, env: { STREAM: StreamBinding }) {
    const url = new URL(request.url);
    if (url.pathname === "/create")
      return Response.json(
        await env.STREAM.createDirectUpload(await request.json()),
      );
    const video = env.STREAM.video(url.searchParams.get("id")!);
    if (request.method === "DELETE") {
      await video.delete();
      return new Response(null, { status: 204 });
    }
    return Response.json(await video.details());
  },
};
