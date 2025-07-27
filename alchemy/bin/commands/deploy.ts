import z from "zod";
import {
  entrypoint,
  execAlchemy,
  execArgs,
  force,
  watch,
} from "../services/execute-alchemy.ts";
import { t } from "../trpc.ts";

export const deploy = t.procedure
  .meta({
    description: "Deploy an Alchemy project",
  })
  .input(
    z.tuple([
      entrypoint,
      z.object({
        ...execArgs,
        force,
        watch,
      }),
    ]),
  )
  .mutation(async ({ input }) => execAlchemy(...input));
