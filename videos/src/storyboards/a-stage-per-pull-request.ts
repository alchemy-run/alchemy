import type { Storyboard } from "../storyboard";

/**
 * Launch piece 8 — "A stage per pull request: deploy on open, destroy on
 * close". Script adapted from processes/Marketing/launch-content-plan.md;
 * all code verbatim-shaped from website/src/content/docs/environments/ci.mdx,
 * cloudflare/tutorial/part-5.mdx, and
 * cloudflare/data/branch-from-shared-database.mdx.
 */
export const aStagePerPullRequest: Storyboard = {
  id: "a-stage-per-pull-request",
  scenes: [
    {
      kind: "title",
      eyebrow: "alchemy",
      title: "A stage per pull request",
      sub: "Deploy on open. Destroy on close. One workflow file.",
      duration: 4.5,
    },
    {
      kind: "code",
      file: ".github/workflows/deploy.yml",
      lines: [
        { text: "name: Deploy" },
        { text: "on:" },
        { text: "  push:" },
        { text: "    branches: [main]" },
        { text: "  pull_request:", focusAt: [0] },
        { text: "    types: [opened, reopened, synchronize, closed]", focusAt: [0] },
        { text: "" },
        { text: "env:", focusAt: [1] },
        { text: "  STAGE: >-", focusAt: [1] },
        { text: "    ${{ github.event_name == 'pull_request'", focusAt: [1] },
        { text: "      && format('pr-{0}', github.event.number)", focusAt: [1] },
        {
          text: "      || (github.ref == 'refs/heads/main' && 'prod' || github.ref_name) }}",
          focusAt: [1, 3],
        },
        { text: "" },
        { text: "jobs:" },
        { text: "  deploy:", focusAt: [2] },
        { text: "    if: github.event.action != 'closed'", focusAt: [2] },
        { text: "    steps:", focusAt: [2] },
        {
          text: "      - run: bun alchemy deploy --stage ${{ env.STAGE }} --yes",
          focusAt: [2, 3],
        },
      ],
      beats: [
        {
          subtitle: "The whole lifecycle is one GitHub Actions file.",
          duration: 3,
        },
        {
          subtitle: "Each pull request computes its own stage — pr-42.",
          duration: 3.5,
        },
        {
          subtitle: "Open or push → deploy that stage. Same command as your laptop.",
          duration: 3.5,
        },
        {
          subtitle: "Pushes to main deploy prod — same program, different stage.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: ".github/workflows/deploy.yml",
      lines: [
        { text: "  cleanup:", focusAt: [0] },
        { text: "    if: >-", focusAt: [0] },
        { text: "      github.event_name == 'pull_request'", focusAt: [0] },
        { text: "      && github.event.action == 'closed'", focusAt: [0] },
        { text: "    steps:" },
        { text: "      - name: Safety Check", focusAt: [1] },
        { text: "        run: |", focusAt: [1] },
        {
          text: '          if [ "${{ env.STAGE }}" = "prod" ]; then',
          focusAt: [1],
        },
        {
          text: '            echo "ERROR: Cannot destroy prod environment"',
          focusAt: [1],
        },
        { text: "            exit 1", focusAt: [1] },
        { text: "          fi", focusAt: [1] },
        { text: "      - name: Destroy Preview", focusAt: [2] },
        {
          text: "        run: bun alchemy destroy --stage ${{ env.STAGE }} --yes",
          focusAt: [2],
        },
      ],
      beats: [
        {
          subtitle: "Merged or closed — a second job takes over.",
          duration: 3,
        },
        {
          subtitle: "A guard keeps prod standing, always.",
          duration: 3,
        },
        {
          subtitle: "destroy --stage pr-42 — the stage's resources are removed.",
          duration: 3.5,
        },
      ],
    },
    {
      kind: "code",
      file: "stacks/github.ts",
      lines: [
        { text: "// deployed once from your laptop, --profile admin" },
        {
          text: 'const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {',
          focusAt: [0],
        },
        { text: "  accountId," },
        { text: "  policies: [{", focusAt: [1] },
        { text: '    effect: "allow",', focusAt: [1] },
        { text: "    permissionGroups: [", focusAt: [1] },
        {
          text: '      "Workers Scripts Write", "D1 Write", "Queues Write", // …',
          focusAt: [1],
        },
        { text: "    ],", focusAt: [1] },
        {
          text: '    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },',
          focusAt: [1],
        },
        { text: "  }]," },
        { text: "});" },
        { text: "" },
        { text: 'yield* GitHub.Secret("cf-api-token", {', focusAt: [2] },
        { text: '  owner: "your-org",' },
        { text: '  repository: "your-repo",' },
        { text: '  name: "CLOUDFLARE_API_TOKEN",', focusAt: [2] },
        { text: "  value: apiToken.value,", focusAt: [2] },
        { text: "});" },
      ],
      beats: [
        {
          subtitle: "The CI credential is a resource too — minted by its own stack.",
          duration: 3,
        },
        {
          subtitle: "Scoped to exactly what the app deploys.",
          duration: 3,
        },
        {
          subtitle: "The fresh token pipes straight into a GitHub Actions secret.",
          duration: 3.5,
          callout: {
            line: 16,
            text: "Cloudflare reveals the value once — it flows API → state → secret",
            kind: "ok",
          },
        },
      ],
    },
    {
      kind: "code",
      file: "alchemy.run.ts",
      lines: [
        { text: "if (process.env.PULL_REQUEST) {" },
        { text: '  yield* GitHub.Comment("preview-comment", {', focusAt: [0, 2] },
        { text: '    owner: "your-org",' },
        { text: '    repository: "your-repo",' },
        { text: "    issueNumber: Number(process.env.PULL_REQUEST)," },
        { text: "    body: Output.interpolate`", focusAt: [1] },
        { text: "      ## Preview Deployed", focusAt: [1] },
        { text: "      **URL:** ${worker.url}", focusAt: [1] },
        {
          text: "      Built from commit ${process.env.GITHUB_SHA?.slice(0, 7)}",
          focusAt: [1],
        },
        { text: "    `," },
        { text: "  });" },
        { text: "}" },
      ],
      beats: [
        {
          subtitle: "The preview URL posts itself — the PR comment is a resource.",
          duration: 3,
        },
        {
          subtitle: "The body interpolates live outputs — the Worker's URL, the SHA.",
          duration: 3,
        },
        {
          subtitle: "Stable logical ID — every push updates the same comment in place.",
          duration: 3.5,
          callout: {
            line: 1,
            text: "ten commits, one comment",
            kind: "ok",
          },
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy --stage pr-42 --yes",
      header: "Apply  4 to create",
      rows: [
        { id: "app-branch", type: "Neon.Branch" },
        { id: "app-hyperdrive", type: "Cloudflare.Hyperdrive.Connection" },
        { id: "Api", type: "Cloudflare.Worker" },
        { id: "preview-comment", type: "GitHub.Comment" },
      ],
      summary: "✓ deployed   https://my-app-pr-42.sam.workers.dev",
      subtitles: [
        "CI runs the same program — against stage pr-42.",
        "A branch off the shared database, a Worker, a live preview URL.",
      ],
      duration: 12,
    },
    {
      kind: "terminal",
      command: "bun alchemy destroy --stage pr-42 --yes",
      header: "Destroy  4 to delete",
      rows: [
        { id: "preview-comment", type: "GitHub.Comment", verb: "delete" },
        { id: "Api", type: "Cloudflare.Worker", verb: "delete" },
        {
          id: "app-hyperdrive",
          type: "Cloudflare.Hyperdrive.Connection",
          verb: "delete",
        },
        { id: "app-branch", type: "Neon.Branch", verb: "delete" },
      ],
      summary: "✓ destroyed   4 resources removed — shared database untouched",
      subtitles: [
        "Merged. The cleanup job tears the whole stage down.",
        "pr-42's branch is deleted — the shared database keeps serving.",
      ],
      duration: 11,
    },
    {
      kind: "end",
      title: "Deploy on open. Destroy on close.",
      url: "v2.alchemy.run",
      note: "alchemy is in beta — bun add alchemy@next",
      duration: 6,
    },
  ],
};
