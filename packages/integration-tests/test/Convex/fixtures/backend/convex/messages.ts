import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const list = queryGeneric({
  args: {},
  handler: (ctx) => ctx.db.query("messages").collect(),
});

export const add = mutationGeneric({
  args: { body: v.string() },
  handler: (ctx, { body }) => ctx.db.insert("messages", { body }),
});

export const ping = actionGeneric({
  args: { n: v.number() },
  handler: async (_ctx, { n }) => n + 1,
});

export const env = queryGeneric({
  args: { name: v.string() },
  handler: async (_ctx, { name }) => process.env[name] ?? null,
});
