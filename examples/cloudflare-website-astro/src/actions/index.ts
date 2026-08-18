// Astro Actions are the site's PUBLIC API: the framework validates input
// and owns the wire (`POST /_actions/<name>`), and each handler calls the
// backend through the trusted, in-process value form of `createClient` —
// schema-less RPC never crosses the trust boundary itself.
import { defineAction } from "astro:actions";
import { createClient } from "alchemy/Client";
import { z } from "astro/zod";
import Backend from "../backend.ts";

// ONE in-process client at module scope: value-form RPC needs no headers
// (a method that must self-authorize takes them explicitly).
const backend = createClient(Backend);

export const server = {
  bump: defineAction({
    handler: () => backend.bump(),
  }),
  enqueue: defineAction({
    input: z.object({ message: z.string().min(1).max(256) }),
    handler: ({ message }) => backend.enqueue(message),
  }),
  processed: defineAction({
    handler: () => backend.processed(),
  }),
};
