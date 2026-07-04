import type { Storyboard } from "../storyboard";

/**
 * Launch piece 7 — "A database branch for every pull request".
 * Script adapted from processes/Marketing/launch-content-plan.md §7; all
 * code verbatim-shaped from
 * website/src/content/docs/planetscale/guides/preview-branches.mdx,
 * website/src/content/docs/cloudflare/data/branch-from-shared-database.mdx,
 * and examples/cloudflare-planetscale-postgres-drizzle/src/{Db,Api}.ts.
 *
 * Story: one conditional splits stages into a long-lived database owner
 * (staging) and ephemeral PR stages that fork a copy-on-write branch,
 * mint a credential, and wire a Worker — then destroy cleanly, with the
 * shared database out of reach by ownership.
 */
export const planetscaleBranchPerPr: Storyboard = {
  id: "planetscale-branch-per-pr",
  scenes: [
    {
      kind: "title",
      eyebrow: "alchemy",
      title: "A database branch for every pull request",
      sub: "Fork, migrate, preview, destroy — off one shared database.",
      duration: 4.5,
    },
    {
      kind: "code",
      file: "src/Db.ts",
      lines: [
        { text: "// every stage deploys this same program" },
        { text: 'import * as Alchemy from "alchemy";' },
        { text: 'import * as Planetscale from "alchemy/Planetscale";' },
        { text: "" },
        { text: "export const Db = Effect.gen(function* () {" },
        { text: "  const { stage } = yield* Alchemy.Stack;", focusAt: [1] },
        { text: "" },
        { text: '  const database = stage.startsWith("pr-")', focusAt: [1, 2] },
        {
          text: '    ? yield* Planetscale.PostgresDatabase.ref("app-db", {',
          focusAt: [2],
        },
        { text: '        stage: "staging",', focusAt: [2] },
        { text: "      })", focusAt: [2] },
        {
          text: '    : yield* Planetscale.PostgresDatabase("app-db", {',
          focusAt: [3],
        },
        { text: '        region: { slug: "us-east" },', focusAt: [3] },
        { text: '        clusterSize: "PS_10",', focusAt: [3] },
        { text: "      });", focusAt: [3] },
        { text: "  // …branch, role, hyperdrive below" },
      ],
      beats: [
        {
          subtitle: "One conditional decides who owns the database.",
          duration: 3,
        },
        {
          subtitle:
            "The stage comes off the CLI — staging, prod, or pr-147.",
          duration: 3,
        },
        {
          subtitle:
            "PR stages reference the database staging already deployed — read from state.",
          duration: 3.5,
        },
        {
          subtitle: "Long-lived stages create it. Same file, same types.",
          duration: 3,
        },
        {
          subtitle:
            "Both paths return a typed PostgresDatabase — downstream code doesn't care.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "src/Db.ts",
      lines: [
        { text: "// below the conditional, nothing is conditional" },
        {
          text: '  const branch = yield* Planetscale.PostgresBranch("app-branch", {',
          focusAt: [0],
        },
        { text: "    database,", focusAt: [0] },
        { text: '    migrationsDir: "./migrations",', focusAt: [1] },
        { text: "  });" },
        { text: "" },
        {
          text: '  const role = yield* Planetscale.PostgresRole("app-role", {',
          focusAt: [2],
        },
        { text: "    database,", focusAt: [2] },
        { text: "    branch,", focusAt: [2] },
        { text: '    inheritedRoles: ["postgres"],', focusAt: [2] },
        { text: "  });" },
        { text: "" },
        { text: "  return { database, branch, role };", focusAt: [3] },
        { text: "});" },
      ],
      beats: [
        {
          subtitle:
            "Every stage forks its own branch — copy-on-write, off the shared database.",
          duration: 3.5,
        },
        {
          subtitle:
            "Pending .sql migrations apply to the branch on every deploy.",
          duration: 3.5,
          callout: {
            line: 3,
            text: "ordered by prefix · SHA-256 hashed · tracked in __alchemy_migrations",
            kind: "ok",
          },
        },
        {
          subtitle: "A credential scoped to that branch — per-stage too.",
          duration: 3,
        },
        {
          subtitle:
            "Branch and credential: the ephemeral tier a PR stage owns.",
          duration: 2.5,
        },
      ],
    },
    {
      kind: "code",
      file: "src/Api.ts",
      lines: [
        { text: "export const Hyperdrive = Effect.gen(function* () {" },
        { text: "  const { role } = yield* Db;" },
        {
          text: '  return yield* Cloudflare.Hyperdrive.Connection("app-hyperdrive", {',
        },
        { text: "    origin: role.origin,", focusAt: [0] },
        { text: "  });" },
        { text: "});" },
        { text: "" },
        { text: "export default class Api extends Cloudflare.Worker<Api>()(" },
        { text: '  "Api",' },
        { text: "  { main: import.meta.url }," },
        { text: "  Effect.gen(function* () {" },
        {
          text: "    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);",
          focusAt: [1],
        },
        {
          text: "    const db = yield* Drizzle.postgres(conn.connectionString);",
          focusAt: [1],
        },
        { text: "    return {" },
        { text: "      fetch: Effect.gen(function* () {" },
        {
          text: "        const users = yield* db.select().from(Users);",
          focusAt: [2],
        },
        { text: "        return yield* HttpServerResponse.json({ users });" },
        { text: "      })," },
        { text: "    };" },
        { text: "  })," },
        { text: ") {}" },
      ],
      beats: [
        {
          subtitle: "The branch credential feeds Hyperdrive.",
          duration: 3,
        },
        {
          subtitle: "The Worker connects through it — one binding call.",
          duration: 3.5,
        },
        {
          subtitle:
            "Drizzle queries the PR's own branch — isolated schema, isolated data.",
          duration: 3.5,
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy --stage staging",
      header: "Apply  5 to create",
      rows: [
        { id: "app-db", type: "Planetscale.PostgresDatabase" },
        { id: "app-branch", type: "Planetscale.PostgresBranch" },
        { id: "app-role", type: "Planetscale.PostgresRole" },
        { id: "app-hyperdrive", type: "Cloudflare.Hyperdrive.Connection" },
        { id: "Api", type: "Cloudflare.Worker" },
      ],
      summary: "✓ deployed   staging owns app-db",
      subtitles: [
        "Staging takes the create path — it owns the database.",
        "Branch migrated, credential minted, Worker live.",
      ],
      duration: 12,
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy --stage pr-147",
      header: "Apply  4 to create   (app-db resolved from staging's state)",
      rows: [
        { id: "app-branch", type: "Planetscale.PostgresBranch" },
        { id: "app-role", type: "Planetscale.PostgresRole" },
        { id: "app-hyperdrive", type: "Cloudflare.Hyperdrive.Connection" },
        { id: "Api", type: "Cloudflare.Worker" },
      ],
      summary: "✓ deployed   https://api-pr-147.sam.workers.dev",
      subtitles: [
        "Same program — pr-147 takes the reference path.",
        "It creates only what it owns: branch, credential, Hyperdrive, Worker.",
        "The preview serves from its own copy-on-write branch.",
      ],
      duration: 12,
    },
    {
      kind: "terminal",
      command: "bun alchemy destroy --stage pr-147",
      header: "Destroy  4 to delete",
      rows: [
        { id: "Api", type: "Cloudflare.Worker", verb: "delete" },
        {
          id: "app-hyperdrive",
          type: "Cloudflare.Hyperdrive.Connection",
          verb: "delete",
        },
        { id: "app-role", type: "Planetscale.PostgresRole", verb: "delete" },
        { id: "app-branch", type: "Planetscale.PostgresBranch", verb: "delete" },
      ],
      summary: "✓ destroyed   4 resources removed — app-db untouched",
      subtitles: [
        "Close the PR, destroy its stage.",
        "Everything the stage owns unwinds — the shared database stays, data intact.",
      ],
      duration: 11,
    },
    {
      kind: "end",
      title: "A branch per PR. One shared database.",
      url: "v2.alchemy.run",
      note: "alchemy is in beta — bun add alchemy@next",
      duration: 6,
    },
  ],
};
