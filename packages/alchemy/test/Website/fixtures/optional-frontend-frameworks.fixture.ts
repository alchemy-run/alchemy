import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { registerHooks } from "node:module";

// Simulate an absent optional peer without changing the workspace install.
let attempts = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@alchemy.run/frontend-frameworks" ||
      specifier.startsWith("@alchemy.run/frontend-frameworks/")
    ) {
      attempts++;
      throw new Error(`Cannot find package '${specifier}'`);
    }
    return nextResolve(specifier, context);
  },
});

const providers: string[] = [];
for (const provider of ["Prisma", "Neon", "Fly", "Hetzner", "Railway"]) {
  const module = await import(`alchemy/${provider}`);
  if (module.Website) providers.push(provider);
}
const providerImportAttempts = attempts;
const { loadFrontendCore } =
  await import("../../../src/Website/FrontendCore.ts");
const result = await Effect.runPromise(Effect.result(loadFrontendCore));
console.log(
  JSON.stringify({
    providers,
    providerImportAttempts,
    loaderImportAttempts: attempts - providerImportAttempts,
    error: Result.isFailure(result)
      ? {
          _tag: result.failure._tag,
          framework: result.failure.framework,
          message: result.failure.message,
          cause:
            result.failure.cause instanceof Error
              ? result.failure.cause.message
              : result.failure.cause,
        }
      : null,
  }),
);
