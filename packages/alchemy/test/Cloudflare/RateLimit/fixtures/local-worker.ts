/// <reference types="@cloudflare/workers-types" />
export default {
  async fetch(
    request: Request,
    env: { FIRST: RateLimit; ALIAS: RateLimit; OTHER: RateLimit },
  ) {
    const url = new URL(request.url);
    const name =
      (url.searchParams.get("binding") as "FIRST" | "ALIAS" | "OTHER") ??
      "FIRST";
    return Response.json(
      await env[name].limit({ key: url.searchParams.get("key") ?? "shared" }),
    );
  },
};
