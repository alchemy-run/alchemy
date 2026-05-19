import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export type DependencyPackageName =
  | "alchemy"
  | "effect"
  | "@effect/platform-bun"
  | "@effect/platform-node"
  | "@cloudflare/workers-types"
  | "@distilled.cloud/cloudflare"
  | "@distilled.cloud/cloudflare-runtime"
  | "@distilled.cloud/cloudflare-vite-plugin"
  | "@distilled.cloud/cloudflare-rolldown-plugin"
  | "@distilled.cloud/core"
  | "sonda"
  | "vite"
  | "@distilled.cloud/aws"
  | "@smithy/types"
  | "@types/aws-lambda"
  | "@distilled.cloud/axiom"
  | "@distilled.cloud/neon"
  | "pg"
  | "@octokit/rest"
  | "libsodium-wrappers"
  | "@types/libsodium-wrappers"
  | "@effect/sql-pg"
  | "drizzle-orm"
  | "drizzle-kit"
  | "@libsql/client"
  | "aws4fetch"
  | "@effect/vitest"
  | "vitest"
  | "ws";

export interface DependencyGroup {
  readonly id: string;
  readonly label: string;
  readonly packages: readonly DependencyPackageName[];
  readonly purpose: string;
}

export class DependencyLoadError extends Data.TaggedError(
  "DependencyLoadError",
)<{
  readonly message: string;
  readonly surface: string;
  readonly installCommand: string;
  readonly packages: readonly DependencyPackageName[];
  readonly cause: unknown;
}> {}

export const coreDependencyGroup = {
  id: "core",
  label: "Alchemy core",
  packages: [
    "alchemy",
    "effect",
    "@effect/platform-bun",
    "@effect/platform-node",
  ],
  purpose:
    "Runs Alchemy programs and supplies the Effect platform layers used by the CLI and runtime adapters.",
} as const satisfies DependencyGroup;

export const requiredPeerDependencyPackages = [
  "effect",
  "@effect/platform-bun",
  "@effect/platform-node",
] as const satisfies readonly DependencyPackageName[];

export const dependencyGroups = {
  aws: {
    id: "aws",
    label: "AWS",
    packages: ["@distilled.cloud/aws", "@smithy/types", "@types/aws-lambda"],
    purpose:
      "Loads AWS resource providers, Smithy credential types, and Lambda handler type declarations.",
  },
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare resources",
    packages: [
      "@cloudflare/workers-types",
      "@distilled.cloud/cloudflare",
      "@distilled.cloud/core",
    ],
    purpose:
      "Loads Cloudflare resource providers, Worker binding type declarations, and shared Distilled error types used by Cloudflare credential loading.",
  },
  cloudflareWorkerRuntime: {
    id: "cloudflare-worker-runtime",
    label: "Cloudflare Worker packaging",
    packages: [
      "@distilled.cloud/cloudflare-runtime",
      "@distilled.cloud/cloudflare-vite-plugin",
      "@distilled.cloud/cloudflare-rolldown-plugin",
      "vite",
    ],
    purpose:
      "Bundles Worker entrypoints and runs local Worker development servers.",
  },
  cloudflareBundleAnalysis: {
    id: "cloudflare-bundle-analysis",
    label: "Cloudflare Worker bundle analysis",
    packages: ["sonda"],
    purpose:
      "Records bundle inspection output when a Worker build requests a metafile.",
  },
  axiom: {
    id: "axiom",
    label: "Axiom",
    packages: ["@distilled.cloud/axiom", "@distilled.cloud/core"],
    purpose:
      "Loads Axiom resource providers and shared Distilled error types used by Axiom credential loading.",
  },
  neon: {
    id: "neon",
    label: "Neon",
    packages: ["@distilled.cloud/neon", "@distilled.cloud/core", "pg"],
    purpose:
      "Loads Neon resource providers, shared Distilled error types used by Neon credential loading, and applies SQL migrations through node-postgres.",
  },
  github: {
    id: "github",
    label: "GitHub",
    packages: [
      "@octokit/rest",
      "libsodium-wrappers",
      "@types/libsodium-wrappers",
    ],
    purpose:
      "Loads GitHub API clients and encrypts repository secrets before upload.",
  },
  drizzle: {
    id: "drizzle",
    label: "Drizzle",
    packages: ["@effect/sql-pg", "drizzle-orm", "drizzle-kit"],
    purpose: "Opens Effect-backed Drizzle Postgres connections.",
  },
  sqlite: {
    id: "sqlite",
    label: "SQLite",
    packages: ["@libsql/client"],
    purpose: "Opens libSQL-backed SQLite connections.",
  },
  kubernetes: {
    id: "kubernetes",
    label: "Kubernetes on AWS",
    packages: ["aws4fetch"],
    purpose: "Signs EKS Kubernetes API requests with AWS credentials.",
  },
  vitest: {
    id: "vitest",
    label: "Vitest test helpers",
    packages: ["@effect/vitest", "vitest"],
    purpose:
      "Runs Effect values through the Vitest integration exported by Alchemy.",
  },
  sidecarWebSocket: {
    id: "sidecar-web-socket",
    label: "Node sidecar WebSocket transport",
    packages: ["ws"],
    purpose: "Starts the Node WebSocket server used by sidecar RPC sessions.",
  },
} as const satisfies Record<string, DependencyGroup>;

export const cloudflareStateStoreDependencyGroup = {
  id: "cloudflare-state-store",
  label: "Cloudflare state store",
  packages: [
    ...dependencyGroups.cloudflare.packages,
    ...dependencyGroups.cloudflareWorkerRuntime.packages,
  ],
  purpose:
    "Deploys the Worker-backed state store used by Cloudflare.state() and bundles Worker entrypoints that use the same packaging path.",
} as const satisfies DependencyGroup;

export const cloudflareCliDependencyGroup = cloudflareStateStoreDependencyGroup;

export const dependencyGroupsByImportSurface = [
  { importSurface: "alchemy/AWS", group: dependencyGroups.aws },
  { importSurface: "alchemy/Cloudflare", group: dependencyGroups.cloudflare },
  {
    importSurface: "Cloudflare.state() and Cloudflare Worker resources",
    group: dependencyGroups.cloudflareWorkerRuntime,
  },
  {
    importSurface: "Cloudflare Worker build metafile output",
    group: dependencyGroups.cloudflareBundleAnalysis,
  },
  { importSurface: "alchemy/Axiom", group: dependencyGroups.axiom },
  { importSurface: "alchemy/Neon", group: dependencyGroups.neon },
  { importSurface: "alchemy/GitHub", group: dependencyGroups.github },
  { importSurface: "alchemy/Drizzle", group: dependencyGroups.drizzle },
  { importSurface: "alchemy/SQLite", group: dependencyGroups.sqlite },
  { importSurface: "alchemy/Kubernetes", group: dependencyGroups.kubernetes },
  { importSurface: "alchemy/Test/Vitest", group: dependencyGroups.vitest },
] as const;

export const dedupePackages = (
  packages: readonly DependencyPackageName[],
): readonly DependencyPackageName[] => Array.from(new Set(packages));

export const combineDependencyGroups = (
  groups: readonly DependencyGroup[],
): readonly DependencyPackageName[] =>
  dedupePackages(groups.flatMap((group) => group.packages));

export const optionalPeerDependencyPackages = dedupePackages(
  Object.values(dependencyGroups).flatMap((group) => group.packages),
).filter(
  (name) =>
    !(requiredPeerDependencyPackages as readonly string[]).includes(name),
);

export const makeAddCommand = (
  packages: readonly DependencyPackageName[],
  packageManager: PackageManager = "bun",
): string => {
  const command =
    packageManager === "npm"
      ? "npm install"
      : packageManager === "yarn"
        ? "yarn add"
        : `${packageManager} add`;
  return `${command} ${dedupePackages(packages).join(" ")}`;
};

export const makeDependencyLoadError = ({
  surface,
  group,
  cause,
}: {
  readonly surface: string;
  readonly group: DependencyGroup;
  readonly cause: unknown;
}) => {
  const installCommand = makeAddCommand(group.packages);
  return new DependencyLoadError({
    message: `${surface} needs the ${group.label} packages before it can load. Run ${installCommand}, then try again.`,
    surface,
    installCommand,
    packages: group.packages,
    cause,
  });
};

export const loadDependencyModule = <Module>({
  surface,
  group,
  load,
}: {
  readonly surface: string;
  readonly group: DependencyGroup;
  readonly load: () => PromiseLike<Module>;
}) =>
  Effect.tryPromise({
    try: () => load(),
    catch: (cause) => makeDependencyLoadError({ surface, group, cause }),
  });
