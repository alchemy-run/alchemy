import { zod as z } from "trpc-cli";
import {
  alchemyEntrypointArg,
  execAlchemy,
  execAlchemyArgs,
} from "../services/execute-alchemy.ts";
import { t } from "../trpc.ts";

export const deploy = t.procedure
  .meta({
    description: "Deploy an Alchemy project",
  })
  .input(
    z.tuple([
      alchemyEntrypointArg,
      z
        .object({
          ...execAlchemyArgs,
          watch: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "Watch for changes to infrastructure and redeploy automatically",
            ),
        })
        .optional()
        .default({}),
    ]),
  )
  .mutation(async ({ input }) => execAlchemy(...input));
