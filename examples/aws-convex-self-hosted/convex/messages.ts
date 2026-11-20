import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const list = queryGeneric({
  args: {},
  handler: (ctx) => ctx.db.query("messages").order("desc").take(20),
});

export const add = mutationGeneric({
  args: { text: v.string() },
  handler: (ctx, { text }) => ctx.db.insert("messages", { text }),
});
