import { zod as z } from "trpc-cli";
import {
  alchemyEntrypointArg,
  execAlchemy,
  execAlchemyArgs,
} from "../services/execute-alchemy.ts";
import { t } from "../trpc.ts";

export const destroy = t.procedure
  .meta({
    description: "Deploy an Alchemy project",
  })
  .input(
    z.tuple([
      alchemyEntrypointArg,
      z.object(execAlchemyArgs).optional().default({}),
    ]),
  )
  .mutation(async ({ input: [main, options] }) =>
    execAlchemy(main, {
      ...options,
      destroy: true,
    }),
  );
