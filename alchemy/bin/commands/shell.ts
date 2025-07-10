import { zod as z } from "trpc-cli";
import {
  alchemyEntrypointArg,
  execAlchemy,
  execAlchemyArgs,
} from "../services/execute-alchemy.ts";
import { t } from "../trpc.ts";

export const shell = t.procedure
  .meta({
    description:
      "Run an Alchemy program with read-only access to your infrastructure (no changes will be applied)",
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
      read: true,
    }),
  );
