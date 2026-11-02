import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const list = queryGeneric({
  args: {},
  handler: (ctx) => ctx.db.query("messages").collect(),
});

export const add = mutationGeneric({
  args: { text: v.string() },
  handler: (ctx, { text }) => ctx.db.insert("messages", { text }),
});
