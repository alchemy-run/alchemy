import { json } from "@tanstack/react-start";
import { createAPIFileRoute } from "@tanstack/react-start/api";
import type { User } from "../../utils/users";

// TODO(sam): this fails vinxi build
import { env } from "cloudflare:workers";

export const APIRoute = createAPIFileRoute("/api/users/$id")({
  GET: async ({ request, params }) => {
    // mock to test bindings work
    await env.BUCKET.list();

    console.info(`Fetching users by id=${params.id}... @`, request.url);
    try {
      const res = await fetch(
        "https://jsonplaceholder.typicode.com/users/" + params.id
      );
      if (!res.ok) {
        throw new Error("Failed to fetch user");
      }

      const user = (await res.json()) as User;

      return json({
        id: user.id,
        name: user.name,
        email: user.email,
      });
    } catch (e) {
      console.error(e);
      return json({ error: "User not found" }, { status: 404 });
    }
  },
});
