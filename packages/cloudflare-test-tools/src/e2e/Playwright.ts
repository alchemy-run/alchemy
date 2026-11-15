import { test } from "@playwright/test";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Runtime from "./Runtime.ts";
import * as Server from "./Server.ts";
import { installTailwindNodeCompat } from "./TailwindNodeCompat.ts";

// Guard every playwright worker process before vite can load tailwind.
installTailwindNodeCompat();

export const SERVER_METHODS = ["live", "dev"] as const;
export type ServerMethod = (typeof SERVER_METHODS)[number];

export const make = (method: ServerMethod) =>
  test.extend<{}, { readonly server: Server.Instance }>({
    server: [
      // oxlint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const harness = await makeServerInstance(method);
        await use(harness);
        await harness.dispose();
      },
      { scope: "worker" },
    ],
  });

const makeServerInstance = async (method: ServerMethod) => {
  const scope = Scope.makeUnsafe();
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- the fixture's framework comes from a dynamically imported module; `Options.FrameworkLayer` can only promise an unknown failure
  const runtime = ManagedRuntime.make(Runtime.layer);
  const instance = await runtime.runPromise(
    Server.Server.use((server) => server[method]()).pipe(Scope.provide(scope)),
  );
  return {
    ...instance,
    dispose: () => runtime.runPromise(Scope.close(scope, Exit.void)),
  };
};
