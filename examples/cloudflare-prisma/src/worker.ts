import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "./generated/prisma/client.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const adapter = new PrismaD1(env.D1);
    const prisma = new PrismaClient({ adapter });

    if (request.url.endsWith("/create")) {
      await prisma.user.create({
        data: {
          email: "test@test.com",
        },
      });
      return new Response("Created");
    }

    const users = await prisma.user.findMany();
    const result = JSON.stringify(users);
    return new Response(result);
  },
} satisfies ExportedHandler<Env>;
