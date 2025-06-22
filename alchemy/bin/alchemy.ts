#!/usr/bin/env node

import { createCli, trpcServer, zod as z } from "trpc-cli";
import { createAlchemy } from "./commands/create.ts";
import { getPackageVersion } from "./services/get-package-version.ts";
import {
  PackageManagerSchema,
  ProjectNameSchema,
  TemplateSchema,
  type CreateInput,
} from "./types.ts";

const t = trpcServer.initTRPC.create();

const router = t.router({
  create: t.procedure
    .meta({
      description: "Create a new Alchemy project",
    })
    .input(
      z.tuple([
        ProjectNameSchema.optional(),
        z
          .object({
            template: TemplateSchema.optional(),
            packageManager: PackageManagerSchema.optional(),
            yes: z
              .boolean()
              .optional()
              .default(false)
              .describe("Skip prompts and use defaults"),
            overwrite: z
              .boolean()
              .optional()
              .default(false)
              .describe("Overwrite existing directory"),
            bun: z
              .boolean()
              .optional()
              .default(false)
              .describe("Use Bun as the package manager"),
            npm: z
              .boolean()
              .optional()
              .default(false)
              .describe("Use npm as the package manager"),
            pnpm: z
              .boolean()
              .optional()
              .default(false)
              .describe("Use pnpm as the package manager"),
            yarn: z
              .boolean()
              .optional()
              .default(false)
              .describe("Use Yarn as the package manager"),
            install: z
              .boolean()
              .optional()
              .describe("Install dependencies after scaffolding"),
          })
          .optional()
          .default({}),
      ]),
    )
    .mutation(async ({ input }) => {
      const [name, options] = input;
      const isTest = process.env.NODE_ENV === "test";
      const combinedInput: CreateInput = {
        name,
        ...options,
        yes: isTest || options.yes,
      };
      await createAlchemy(combinedInput);
    }),
});

export type AppRouter = typeof router;

const cli = createCli({
  router,
  name: "alchemy",
  version: getPackageVersion(),
  description:
    "🧪 Welcome to Alchemy! Creating infrastructure as code with JavaScript and TypeScript.",
});

cli.run();
