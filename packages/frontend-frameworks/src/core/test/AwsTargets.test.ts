import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildChildOptions } from "../BuildChild.ts";
import type { DeployTargetBuildContext } from "../DeployTarget.ts";

// Every wholesale AWS target builds in a `runBuildChild` child; capture the
// options it is handed instead of running a real framework build.
const builds = vi.hoisted(() => [] as Array<BuildChildOptions>);
vi.mock("../BuildChild.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../BuildChild.ts")>()),
  runBuildChild: (options: BuildChildOptions) => {
    builds.push(options);
    return Effect.succeed({});
  },
}));

const targets: Array<{
  name: string;
  load: () => Promise<{
    target: () => {
      build: (
        context: DeployTargetBuildContext,
      ) => Effect.Effect<unknown, unknown>;
    };
  }>;
}> = [
  { name: "astro", load: () => import("../../astro/aws.ts") },
  { name: "nuxt", load: () => import("../../nuxt/aws.ts") },
  { name: "octane", load: () => import("../../octane/aws.ts") },
  { name: "react-router", load: () => import("../../react-router/aws.ts") },
  { name: "solidstart", load: () => import("../../solidstart/aws.ts") },
  { name: "sveltekit", load: () => import("../../sveltekit/aws.ts") },
  { name: "tanstack-start", load: () => import("../../tanstack-start/aws.ts") },
  { name: "vinext", load: () => import("../../vinext/aws.ts") },
  { name: "vite", load: () => import("../../vite/aws.ts") },
  { name: "waku", load: () => import("../../waku/aws.ts") },
];

beforeEach(() => {
  builds.length = 0;
});

// The site's `env` (Vite `import.meta.env`, `define`s, prerender) must reach
// the build child on AWS exactly as it does on the node targets.
describe("AWS targets", () => {
  it.each(targets)(
    "$name forwards the site env to the build child",
    async ({ load }) => {
      const { target } = await load();
      const env = { SITE_BUILD_VAR: "from-site" };
      await Effect.runPromise(
        target().build({ root: "/project", env }) as Effect.Effect<unknown>,
      );
      expect(builds).toHaveLength(1);
      expect(builds[0]?.env).toEqual(env);
    },
  );
});
