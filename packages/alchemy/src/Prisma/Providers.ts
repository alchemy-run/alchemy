import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Schema, SchemaProvider } from "./Schema.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Prisma",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build-time providers for managing Prisma schemas as Alchemy resources.
 * Prisma.Schema regenerates migration SQL via `prisma migrate diff` on every
 * deploy when `schema.prisma` changes.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Prisma from "alchemy/Prisma";
 * import * as Neon from "alchemy/Neon";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Layer.mergeAll(
 *       Cloudflare.providers(),
 *       Prisma.providers(),
 *       Neon.providers(),
 *     ),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const schema = yield* Prisma.Schema("app-schema", {
 *       schema: "./prisma/schema.prisma",
 *     });
 *     const project = yield* Neon.Project("app-db");
 *     const branch = yield* Neon.Branch("app-branch", {
 *       project,
 *       migrationsDir: schema.out,
 *     });
 *     return { branchId: branch.branchId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Schema])).pipe(
    Layer.provide(SchemaProvider()),
    Layer.orDie,
  );
