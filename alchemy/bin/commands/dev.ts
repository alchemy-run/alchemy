import z from "zod";
import {
  entrypoint,
  execAlchemy,
  execArgs,
  force,
} from "../services/execute-alchemy.ts";
import { loggedProcedure } from "../trpc.ts";

export const dev = loggedProcedure
  .meta({
    description: "run alchemy in dev mode",
  })
  .input(
    z.tuple([
      entrypoint,
      z.object({
        ...execArgs,
        force,
      }),
    ]),
  )
  .mutation(async ({ input: [main, options] }) =>
    execAlchemy(main, {
      ...options,
      dev: true,
      watch: true,
    }),
  );
