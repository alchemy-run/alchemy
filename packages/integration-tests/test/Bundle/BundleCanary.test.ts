import * as path from "node:path";
import { makeFunctionBundler } from "@alchemy.run/aws/Lambda/FunctionBundle";
import { getCompatibility } from "@alchemy.run/cloudflare/Workers/Compatibility";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Bundle from "alchemy/Bundle/Bundle";
import * as Effect from "effect/Effect";
import type * as rolldown from "rolldown";

/**
 * Canary over the bundles Alchemy ships: each fixture is bundled with the
 * exact options its provider deploys with, and the test checks how much of
 * the module graph Rolldown had to parse, how big the output is, and which
 * provider services ended up in it.
 *
 * Every runtime fixture comes in two styles — `import * as AWS from
 * "@alchemy.run/aws"` and per-service imports (`@alchemy.run/aws/Lambda`) —
 * and both must cost the same: `lazyBarrel` plus the namespace-import rewrite
 * keep the root barrel from pulling every service into the build.
 */

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", "canary", name);

interface BundleStats {
  /** Modules Rolldown parsed (the cost of a build: time and memory). */
  readonly parsed: ReadonlyArray<string>;
  /** Modules that ended up in the output chunks. */
  readonly bundled: ReadonlyArray<string>;
  /** Total bytes of JavaScript emitted (source maps excluded). */
  readonly bytes: number;
}

/** A plugin that records {@link BundleStats} for the build it is added to. */
const measure = () => {
  const parsed: string[] = [];
  const bundled: string[] = [];
  let bytes = 0;
  const plugin: rolldown.Plugin = {
    name: "canary:measure",
    moduleParsed(info) {
      parsed.push(info.id);
    },
    // After Alchemy's own `generateBundle` hooks, which drop unreachable
    // chunks: measure what actually ships.
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          bundled.push(...Object.keys(output.modules));
          bytes += output.code.length;
        }
      },
    },
  };
  return { plugin, stats: (): BundleStats => ({ parsed, bundled, bytes }) };
};

/** The provider service directories (`AWS/S3`, `Cloudflare/KV`, …) a set of modules comes from. */
const servicesOf = (modules: ReadonlyArray<string>, pkg: "aws" | "cloudflare") => {
  const re = new RegExp(`[\\\\/]packages[\\\\/]${pkg}[\\\\/]src[\\\\/]([^\\\\/]+)[\\\\/]`);
  return [...new Set(modules.flatMap((id) => re.exec(id)?.[1] ?? []))].sort();
};

const bundleLambda = (main: string) =>
  Effect.gen(function* () {
    const { resolveBundlePlan } = yield* makeFunctionBundler;
    const { plugin, stats } = measure();
    const plan = yield* resolveBundlePlan({ main, build: { plugins: [plugin] } });
    yield* Bundle.build(plan.inputOptions, plan.outputOptions, plan.extra);
    return stats();
  });

const bundleWorker = (main: string) =>
  Effect.gen(function* () {
    const bundler = yield* WorkerBundle;
    const { plugin, stats } = measure();
    yield* bundler.build({
      id: "CanaryWorker",
      main,
      compatibility: getCompatibility({ main }),
      entry: { kind: "effect", exports: {} },
      stack: { name: "BundleCanary", stage: "test" },
      extraOptions: { input: { plugins: [plugin] } },
    });
    return stats();
  });

interface Budget {
  /** Most modules Rolldown may parse for this runtime. */
  readonly parsed: number;
  /** Most JavaScript bytes the runtime may ship. */
  readonly bytes: number;
  /** The provider services whose code ships in the bundle — no others. */
  readonly services: ReadonlyArray<string>;
}

const report = (label: string, stats: BundleStats, pkg: "aws" | "cloudflare") =>
  Effect.log(
    `${label}: parsed=${stats.parsed.length} bundled=${stats.bundled.length} bytes=${stats.bytes} services=${servicesOf(stats.bundled, pkg).join(",")}`,
  );

/**
 * Deploy-time code that must never ship in a runtime: the bundler, the CLI's
 * platform layer (Bun's platform and `ws` came with it), and profile and
 * credential stores.
 */
const DEPLOY_ONLY = [
  /[\\/](rolldown|@rolldown)[\\/]/,
  /[\\/]node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?ws[\\/]/,
  /[\\/]@effect[\\/]platform-bun[\\/]/,
  /[\\/]alchemy[\\/]src[\\/](Auth|Cli|Bundle)[\\/]/,
  /[\\/]alchemy[\\/]src[\\/](EvalStack|Deploy|Destroy|Plan|Apply)\.ts$/,
];

const expectWithinBudget = (stats: BundleStats, pkg: "aws" | "cloudflare", budget: Budget) => {
  expect(stats.parsed.length).toBeLessThanOrEqual(budget.parsed);
  expect(stats.bytes).toBeLessThanOrEqual(budget.bytes);
  expect(servicesOf(stats.bundled, pkg)).toEqual(budget.services);
  expect(stats.bundled.filter((id) => DEPLOY_ONLY.some((re) => re.test(id)))).toEqual([]);
};

/**
 * `ns.Service` still loads that one service's barrel in full, so the
 * namespace style may parse somewhat more than the per-service style —
 * never another provider's worth (before `lazyBarrel` and the rewrite,
 * `import * as AWS` parsed ~8,500 modules against ~800).
 */
const expectSameCost = (namespace: BundleStats, subpath: BundleStats) => {
  expect(namespace.parsed.length).toBeLessThanOrEqual(Math.ceil(subpath.parsed.length * 1.25));
  expect(Math.abs(namespace.bytes - subpath.bytes)).toBeLessThan(1_000);
  expect(namespace.bundled.length).toBe(subpath.bundled.length);
};

// Budgets are measured values plus ~25% headroom. Raise them only for a
// change that is meant to grow every runtime.
const AWS_LAMBDA: Budget = {
  parsed: 1_000,
  bytes: 640_000,
  services: ["Bootstrap", "Lambda", "S3"],
};
const CLOUDFLARE_WORKER: Budget = {
  parsed: 1_500,
  bytes: 480_000,
  services: ["KV", "Workers"],
};

layer(NodeServices.layer)("bundle canary", (it) => {
  it.effect(
    "AWS Lambda with an S3 binding",
    () =>
      Effect.gen(function* () {
        const namespace = yield* bundleLambda(fixture("aws-namespace.ts"));
        const subpath = yield* bundleLambda(fixture("aws-subpath.ts"));
        yield* report("import * as AWS", namespace, "aws");
        yield* report("@alchemy.run/aws/<Service>", subpath, "aws");
        expectWithinBudget(namespace, "aws", AWS_LAMBDA);
        expectWithinBudget(subpath, "aws", AWS_LAMBDA);
        expectSameCost(namespace, subpath);
      }),
    { tags: ["unit", "local"], timeout: 120_000 },
  );

  it.effect(
    "Cloudflare Worker with a KV binding",
    () =>
      Effect.gen(function* () {
        const namespace = yield* bundleWorker(fixture("cloudflare-namespace.ts"));
        const subpath = yield* bundleWorker(fixture("cloudflare-subpath.ts"));
        yield* report("import * as Cloudflare", namespace, "cloudflare");
        yield* report("@alchemy.run/cloudflare/<Service>", subpath, "cloudflare");
        expectWithinBudget(namespace, "cloudflare", CLOUDFLARE_WORKER);
        expectWithinBudget(subpath, "cloudflare", CLOUDFLARE_WORKER);
        expectSameCost(namespace, subpath);
      }),
    { tags: ["unit", "local"], timeout: 120_000 },
  );
});
