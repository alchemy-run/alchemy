import z from "zod";
import {
  entrypoint,
  execAlchemy,
  execArgs,
  force,
} from "../services/execute-alchemy.ts";
import { t } from "../trpc.ts";

export const dev = t.procedure
  .meta({
    description:
      "Run an Alchemy program in dev-mode (local simulation & hot reloading)",
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
