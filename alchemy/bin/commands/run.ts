import z from "zod";
import {
  entrypoint,
  execAlchemy,
  execArgs,
  watch,
} from "../services/execute-alchemy.ts";
import { loggedProcedure } from "../trpc.ts";

export const run = loggedProcedure
  .meta({
    description: "run alchemy in read-only mode",
  })
  .input(
    z.tuple([
      entrypoint,
      z.object({
        ...execArgs,
        watch,
      }),
    ]),
  )
  .mutation(async ({ input: [main, options] }) =>
    execAlchemy(main, {
      ...options,
      read: true,
    }),
  );
