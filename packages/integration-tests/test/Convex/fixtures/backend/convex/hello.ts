import { queryGeneric } from "convex/server";

export const get = queryGeneric({ args: {}, handler: async () => "hello from the fixture" });
