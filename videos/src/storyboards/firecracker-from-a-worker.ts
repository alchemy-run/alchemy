import type { Storyboard } from "../storyboard";

/**
 * Launch piece 6 — "Boot a Firecracker microVM from a Cloudflare Worker".
 * Script adapted from processes/Marketing/launch-content-plan.md §6; all code
 * verbatim-shaped from the published benchmark post
 * (website/src/content/docs/blog/2026-07-01-microvm-cold-starts.md), the
 * MicroVM docs (website/src/content/docs/aws/compute/microvms.mdx), and
 * packages/alchemy/src/AWS/Lambda/MicrovmBinding.ts.
 *
 * Corrections applied: boot time stated as 3.6s median / 4.2s worst case (the
 * published via-Worker row); the answer "comes back" (no streaming claim); the Role trust
 * policy is shown on screen to answer the sts:AssumeRole-on-* question; the
 * preview/5 TPS/OIDC caveats are stated in the bridge scene.
 */
export const firecrackerFromAWorker: Storyboard = {
  id: "firecracker-from-a-worker",
  scenes: [
    {
      kind: "title",
      eyebrow: "alchemy",
      title: "Boot a Firecracker microVM from a Cloudflare Worker",
      sub: "One binding call builds the whole cross-cloud bridge.",
      duration: 4.5,
    },
    {
      kind: "code",
      file: "sandbox.ts",
      lines: [
        { text: "// the thing being booted — a TypeScript program" },
        { text: "export class EffectfulBun extends AWS.Lambda.MicrovmImage<", focusAt: [0] },
        { text: "  EffectfulBun,", focusAt: [0] },
        { text: "  {" },
        {
          text: "    hello: (message: string) => Effect.Effect<string>;",
          focusAt: [1],
        },
        { text: "  }" },
        { text: '>()("MicrovmEffectfulBun") {}', focusAt: [0] },
        { text: "" },
        { text: "export default EffectfulBun.make(" },
        {
          text: '  { main: import.meta.filename, runtime: "bun" },',
          focusAt: [2, 3],
        },
        { text: "  Effect.gen(function* () {" },
        { text: "    return {" },
        { text: "      fetch: Effect.succeed(HttpServerResponse.text(\"ok\"))," },
        {
          text: "      hello: (message) => Effect.succeed(`hello, ${message}!`),",
          focusAt: [1],
        },
        { text: "    };" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        {
          subtitle: "The sandbox is a TypeScript program — the class is its typed handle.",
          duration: 3,
        },
        {
          subtitle: "It exposes a typed RPC method. The type IS the contract.",
          duration: 3,
        },
        {
          subtitle: "Deploying builds a Firecracker image on AWS — and snapshots the running process.",
          duration: 3.5,
        },
        {
          subtitle: "Startup is paid once, at build time. Every boot resumes the snapshot.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "worker.ts",
      lines: [
        { text: "// a Cloudflare Worker, driving AWS Firecracker" },
        { text: "export default Cloudflare.Worker(" },
        { text: '  "MicrovmBenchWorker",' },
        { text: "  { main: import.meta.filename }," },
        { text: "  Effect.gen(function* () {" },
        {
          text: "    const run = yield* AWS.Lambda.RunMicrovm(EffectfulBun);",
          focusAt: [0, 1],
        },
        {
          text: "    const auth = yield* AWS.Lambda.CreateAuthToken(EffectfulBun);",
          focusAt: [0],
        },
        {
          text: "    const terminate = yield* AWS.Lambda.TerminateMicrovm(EffectfulBun);",
          focusAt: [0],
        },
        { text: "" },
        { text: "    return {" },
        { text: "      fetch: Effect.gen(function* () {" },
        { text: "        // boot, call, terminate — next" },
        { text: "      })," },
        { text: "    };" },
        { text: "  })," },
        { text: ");" },
      ],
      beats: [
        {
          subtitle: "The Worker binds the MicroVM lifecycle — three lines.",
          duration: 3,
        },
        {
          subtitle: "Each line registers its IAM grant at deploy and returns the typed client at runtime.",
          duration: 3.5,
          callout: {
            line: 5,
            text: "least-privilege statements generated from binding calls",
            kind: "ok",
          },
        },
        {
          subtitle: "Those three lines are the Worker's entire relationship with AWS.",
          duration: 3,
        },
      ],
    },
    {
      kind: "code",
      file: "worker.ts — fetch",
      lines: [
        { text: "fetch: Effect.gen(function* () {" },
        { text: "  const vm = yield* run({});", focusAt: [0] },
        { text: "  const { authToken } = yield* auth({", focusAt: [1] },
        { text: "    microvmIdentifier: vm.microvmId,", focusAt: [1] },
        { text: "    expirationInMinutes: 5,", focusAt: [1] },
        { text: "    allowedPorts: [{ port: 8080 }],", focusAt: [1] },
        { text: "  });", focusAt: [1] },
        {
          text: "  const sandbox = yield* AWS.Lambda.connectMicrovm(EffectfulBun, {",
          focusAt: [2],
        },
        { text: "    endpoint: vm.endpoint,", focusAt: [2] },
        { text: "    authToken,", focusAt: [2] },
        { text: "  });", focusAt: [2] },
        {
          text: '  const greeting = yield* sandbox.hello("bench");',
          focusAt: [3],
        },
        {
          text: "  yield* terminate({ microvmIdentifier: vm.microvmId });",
          focusAt: [4],
        },
        { text: "  return HttpServerResponse.text(greeting);" },
        { text: "})," },
      ],
      beats: [
        {
          subtitle: "On request: launch a fresh Firecracker VM.",
          duration: 3,
        },
        {
          subtitle: "Mint a scoped auth token for its endpoint.",
          duration: 3,
        },
        {
          subtitle: "connectMicrovm returns a typed stub — Schemaless RPC into the VM.",
          duration: 3,
        },
        {
          subtitle: "sandbox.hello is a compile-checked call into a real microVM.",
          duration: 3,
        },
        {
          subtitle: "Then terminate. The VM lives exactly as long as the request.",
          duration: 3,
        },
      ],
    },
    {
      kind: "terminal",
      command: "bun alchemy deploy",
      header: "Apply  5 to create",
      rows: [
        { id: "Sandbox", type: "AWS.Lambda.MicrovmImage" },
        { id: "MicrovmWorker-microvm-user", type: "AWS.IAM.User" },
        { id: "MicrovmWorker-microvm-key", type: "AWS.IAM.AccessKey" },
        { id: "MicrovmWorker-microvm-role", type: "AWS.IAM.Role" },
        { id: "MicrovmWorker", type: "Cloudflare.Worker" },
      ],
      summary: "✓ deployed   https://microvm-worker.sam.workers.dev",
      subtitles: [
        "One deploy spans both clouds.",
        "The binding minted the bridge: IAM User → AccessKey → Role.",
        "The key does one thing — assume that Role.",
      ],
      duration: 13,
    },
    {
      kind: "terminal",
      command: "curl -X POST https://microvm-worker.sam.workers.dev/rpc",
      output: ['{"reply":"hello, world!","echo":"world"}'],
      subtitles: [
        "A Firecracker VM boots in AWS — 3.6s median, 4.2s worst case.",
        "Typed RPC in, answer out, VM terminated.",
      ],
      duration: 9,
    },
    {
      kind: "code",
      file: "generated at deploy — MicrovmBinding.ts",
      lines: [
        { text: "// created once per Worker, by the binding" },
        { text: "const user = yield* User(`${id}-microvm-user`, {", focusAt: [0] },
        { text: '  inlinePolicies: {', focusAt: [0] },
        { text: '    "assume-microvm-role": {', focusAt: [0] },
        { text: "      Statement: [" },
        {
          text: '        { Effect: "Allow", Action: ["sts:AssumeRole"], Resource: ["*"] },',
          focusAt: [0],
        },
        { text: "      ]," },
        { text: "    }," },
        { text: "  }," },
        { text: "});" },
        { text: "const accessKey = yield* AccessKey(`${id}-microvm-key`, {", focusAt: [1] },
        { text: "  userName: user.userName,", focusAt: [1] },
        { text: "});" },
        { text: "const role = yield* Role(`${id}-microvm-role`, {", focusAt: [2] },
        { text: "  assumeRolePolicyDocument: {" },
        { text: "    Statement: [" },
        {
          text: '      { Effect: "Allow", Principal: { AWS: user.userArn },',
          focusAt: [2],
        },
        { text: '        Action: ["sts:AssumeRole"] },', focusAt: [2] },
        { text: "    ]," },
        { text: "  }," },
        { text: "});" },
      ],
      beats: [
        {
          subtitle: "The bridge is ordinary Alchemy resources — an IAM User that can only AssumeRole.",
          duration: 3.5,
        },
        {
          subtitle: "Its AccessKey lands in the Worker as a secret.",
          duration: 3,
        },
        {
          subtitle: "The Role trusts exactly one principal — assumption is locked on this side.",
          duration: 3.5,
          callout: {
            line: 16,
            text: "trust policy restricts who can assume — permissions accumulate on this Role",
            kind: "ok",
          },
        },
        {
          subtitle: "At runtime: one STS call per isolate. Everything else uses short-lived creds.",
          duration: 3,
        },
        {
          subtitle: "Caveats: AWS preview (alchemy aws bootstrap) · 5 TPS limit · OIDC roadmap.",
          duration: 3.5,
        },
      ],
    },
    {
      kind: "end",
      title: "Two clouds. One program.",
      url: "v2.alchemy.run",
      note: "alchemy is in beta — bun add alchemy@next",
      duration: 6,
    },
  ],
};
