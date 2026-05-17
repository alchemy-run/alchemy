import { getDb } from "./db";

export async function getDashboardData(limit = 10) {
  const db = getDb();
  const runtime = db.runtime();

  const users = await runtime.execute(
    db.sql.user
      .select("id", "email", "name", "createdAt")
      .orderBy("createdAt", { direction: "desc" })
      .limit(limit)
      .build(),
  );

  const posts = await runtime.execute(
    db.sql.post
      .select("id", "title", "excerpt", "userId", "createdAt")
      .orderBy("createdAt", { direction: "desc" })
      .limit(limit)
      .build(),
  );

  return {
    users,
    posts,
    counts: {
      users: users.length,
      posts: posts.length,
    },
  };
}
