// convex/messages.ts
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const list = queryGeneric({
  args: {},
  handler: (ctx) => ctx.db.query("messages").collect(),
});

export const add = mutationGeneric({
  args: { body: v.string() },
  handler: (ctx, { body }) => ctx.db.insert("messages", { body }),
});
