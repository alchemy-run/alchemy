import { describe } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../Utils/Http.ts";
import Stack from "./fixtures/entrypoint-props/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const TENANT = `props=${JSON.stringify({ tenant: "acme" })}`;

const routes = (variant: "effect" | "async") => [
  { name: "an external request has empty props", path: "/props", expected: "props={}" },
  {
    name: "a Worker handler mints a default entrypoint stub with props",
    path: "/mint",
    expected: `via-worker:${TENANT}`,
  },
  {
    name: "a Durable Object mints a host entrypoint stub with props",
    path: "/mint-do",
    expected: `via-do:${TENANT}`,
  },
  // Effect Workers export only `default`; a named entrypoint is a native class.
  ...(variant === "async"
    ? [
        {
          name: "a Worker handler mints a named entrypoint stub with props",
          path: "/mint-named",
          expected: `via-named:${TENANT}`,
        },
      ]
    : []),
  {
    name: "an entrypoint the Worker does not export is unavailable",
    path: "/missing",
    expected: variant === "effect" ? "EntrypointUnavailableError:Missing" : "undefined:Missing",
  },
];

for (const variant of ["effect", "async"] as const) {
  describe(
    `ctx.props and self entrypoint stubs (${variant})`,
    { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
    () => {
      for (const route of routes(variant)) {
        test(
          route.name,
          Effect.gen(function* () {
            const urls = yield* stack;
            const url = variant === "effect" ? urls.effectUrl : urls.asyncUrl;
            yield* expectUrlContains(`${url}${route.path}`, route.expected, {
              label: `${variant} ${route.path}`,
            });
          }).pipe(logLevel),
          { timeout: 180_000 },
        );
      }
    },
  );
}
