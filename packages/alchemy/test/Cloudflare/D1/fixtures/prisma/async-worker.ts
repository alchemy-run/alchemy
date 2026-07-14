import type { D1Database } from "@cloudflare/workers-types";
import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "./generated/client.ts";

interface Env {
  DB: D1Database;
}

/**
 * Async (non-Effect) Worker fixture for Prisma over D1. The database is
 * declared on the Worker `env` as `DB` (see `stack.ts`), so the handler
 * constructs the generated client directly with the official driver
 * adapter — no alchemy runtime wrapper involved:
 *
 *   new PrismaClient({ adapter: new PrismaD1(env.DB) })
 *
 * Same route contract as the Effect worker (`worker.ts`); the live test
 * distinguishes rows by name.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const prisma = new PrismaClient({ adapter: new PrismaD1(env.DB) });
    const url = new URL(request.url, "http://x");

    try {
      if (request.method === "POST" && url.pathname === "/widgets") {
        const body = (await request.json()) as { name: string };
        const widget = await prisma.widget.create({
          data: { name: body.name },
        });
        return Response.json({ widget });
      }

      if (request.method === "GET" && url.pathname === "/widgets") {
        const widgets = await prisma.widget.findMany({
          orderBy: { id: "asc" },
        });
        return Response.json({ widgets });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      // Surface Prisma failures as a JSON 500 so the live test can read the
      // actual error instead of an opaque workerd exception page.
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
};
