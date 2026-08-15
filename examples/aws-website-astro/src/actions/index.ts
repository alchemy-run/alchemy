// Astro Actions are the site's PUBLIC API: the framework validates input
// and owns the wire (`POST /_actions/<name>`), and each handler calls the
// backend through the trusted, in-process value form of `createClient` —
// schema-less RPC never crosses the trust boundary itself.
import { defineAction, type ActionAPIContext } from "astro:actions";
import { createClient } from "alchemy/Client";
import { z } from "astro/zod";
import Backend from "../backend.ts";

const backend = (ctx: ActionAPIContext) =>
  createClient(Backend, { headers: ctx.request.headers });

export const server = {
  bump: defineAction({
    handler: (_input, ctx) => backend(ctx).bump(),
  }),
  enqueue: defineAction({
    input: z.object({ message: z.string().min(1).max(256) }),
    handler: ({ message }, ctx) => backend(ctx).enqueue(message),
  }),
  processed: defineAction({
    handler: (_input, ctx) => backend(ctx).processed(),
  }),
};
