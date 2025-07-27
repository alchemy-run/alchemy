import z from "zod";
import {
  entrypoint,
  execAlchemy,
  execArgs,
  watch,
} from "../services/execute-alchemy.ts";
import { t } from "../trpc.ts";

export const run = t.procedure
  .meta({
    description:
      "Run an Alchemy program with read-only access to your infrastructure (no changes will be applied)",
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
