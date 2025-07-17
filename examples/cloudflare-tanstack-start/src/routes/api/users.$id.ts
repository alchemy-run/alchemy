import { json } from "@tanstack/react-start";
import { createServerFileRoute } from "@tanstack/react-start/server";
import type { User } from "../../utils/users.js";

export const ServerRoute = createServerFileRoute("/api/users/$id").methods({
  GET: async ({ request, params }) => {
    console.info(`Fetching users by id=${params.id}... @`, request.url);
    try {
      const res = await fetch(
        `https://jsonplaceholder.typicode.com/users/${params.id}`,
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
