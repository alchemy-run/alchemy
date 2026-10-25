/**
 * A short talk: what Alchemy is. It follows the "What is Alchemy?" docs page
 * (website/src/content/docs/what-is-alchemy.mdx): infrastructure and the code
 * that runs on it, built with Effects and Layers; how that differs from plain
 * Infrastructure as Code; and the Infrastructure as Code underneath.
 * `intro/build.ts what` resolves this into `out/capture/what/intro.json`;
 * open it with `?deck=what` in the presenter.
 *
 * Code comes from `snippets/what/` and is type-checked.
 */
import type { PyramidLayer } from "../shared/intro.ts";
import type { CodeSpec, PyramidSpec, StepSpec, TerminalSpec } from "./steps.ts";

// ── helpers ──────────────────────────────────────────────────────────────

const code = (
  s: Omit<CodeSpec, "kind" | "src"> & { snippet: string; regions?: string[] },
): CodeSpec => {
  const { snippet, regions, ...rest } = s;
  return {
    kind: "code",
    src: { snippet: `what/${snippet}`, regions: regions ?? ["show"] },
    ...rest,
  };
};

const slide = (title: string, heading: string, notes: string, subtitle?: string): StepSpec => ({
  kind: "slide",
  layout: "section",
  title,
  heading,
  subtitle,
  notes,
});

const LAYERS: PyramidLayer[] = [
  {
    id: "infra",
    title: "Infrastructure",
    detail: "compute · databases · buckets · queues",
    color: "#8b9cf6",
  },
  {
    id: "config",
    title: "Configuration & policies",
    detail: "IAM · env vars · secrets",
    color: "#e0a86b",
  },
  { id: "api", title: "APIs & business logic", detail: "handlers · services", color: "#a3c473" },
  { id: "web", title: "Frontend", detail: "websites · CDN · domains", color: "#e06c9f" },
];
const pyramid = (s: Omit<PyramidSpec, "kind" | "layers">): PyramidSpec => ({
  kind: "pyramid",
  layers: LAYERS,
  frames: 24,
  ...s,
});
const CUT = { under: "api", above: "runtime program", below: "infrastructure program" };
const UPLOAD = {
  label: "serve an upload",
  items: {
    infra: "Uploads bucket",
    config: "access · env.Uploads",
    api: "fetch handler",
    web: "download link",
  },
};

const T = {
  ok: "\x1b[38;5;113m",
  soft: "\x1b[38;5;150m",
  accent: "\x1b[38;5;173m",
  grey: "\x1b[38;5;102m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};
const RULE = `${T.grey}${T.dim}${"─".repeat(52)}${T.reset}`;
const res = (name: string, type: string) =>
  `${T.bold}${name}${T.reset} ${T.dim}(${type})${T.reset}`;
const term = (s: Omit<TerminalSpec, "kind" | "lines"> & { lines: string[] }): TerminalSpec => ({
  kind: "terminal",
  ...s,
  lines: s.lines.join("\n"),
});

/** What the GetItem binding adds to the Lambda Function when you deploy. */
const GENERATED = `# IAM policy
- Effect: Allow
  Action: dynamodb:GetItem
  Resource: arn:aws:dynamodb:…:table/Jobs-a1b2c3

# environment
Jobs_tableName: Jobs-a1b2c3`;

// ── the talk ─────────────────────────────────────────────────────────────

const opening: StepSpec[] = [
  {
    kind: "slide",
    layout: "title",
    title: "What is Alchemy?",
    eyebrow: "Alchemy",
    heading: "What is Alchemy?",
    subtitle: "Cloud applications built with Effects and Layers",
    footer: "alchemy.run",
    notes:
      "Alchemy is a TypeScript framework for building cloud applications with Effects and Layers. Your infrastructure and the code that runs on it are written together, type-checked together, and deployed together.",
  },
];

const together: StepSpec[] = [
  code({
    snippet: "api.ts",
    file: "src/api.ts",
    group: "api",
    title: "An R2 Bucket and a Worker that serves files from it",
    notes:
      "Here's a whole app in one file. An R2 Bucket, and a Worker that serves a file from it. The Bucket is declared right next to the Worker that uses it.",
  }),
  code({
    snippet: "api.ts",
    file: "src/api.ts",
    group: "api",
    title: "The Worker asks for the Bucket in its own code",
    marks: [
      {
        kind: "circle",
        find: "Cloudflare.R2.ReadWriteBucket(Uploads)",
        label: "access when you deploy",
        side: "right",
        tone: "construct",
        arrow: true,
      },
    ],
    notes:
      "The Worker asks for the Bucket itself. This one line does two jobs. When you deploy, it gives the Worker access to the Bucket.",
  }),
  code({
    snippet: "api.ts",
    file: "src/api.ts",
    group: "api",
    title: "…and gets back a typed client",
    marks: [
      {
        kind: "underline",
        find: 'bucket.get("hello.txt")',
        label: "checked like any function call",
        side: "right",
        tone: "runtime",
        arrow: true,
      },
    ],
    notes:
      "And when the Worker runs, the same line hands back a typed client. So bucket.get is checked by the compiler like any other function call.",
  }),
  code({
    snippet: "jobs.ts",
    file: "src/api.ts",
    group: "aws",
    title: "On AWS, the same kind of line writes the IAM policy",
    beside: { file: "generated at deploy", lang: "yaml", src: { code: GENERATED } },
    links: [
      { from: "AWS.DynamoDB.GetItem(Jobs)", to: "dynamodb:GetItem", tone: "good" },
      { from: "AWS.DynamoDB.GetItem(Jobs)", to: "Jobs_tableName", tone: "good" },
    ],
    notes:
      "It's the same on AWS. Ask for GetItem on the Jobs table, and Alchemy writes an IAM statement that allows exactly that call on exactly that table, and puts the table's name in the Function's environment. No name to keep in sync, no policy to write, no client to set up.",
  }),
];

const moreThanIac: StepSpec[] = [
  slide(
    "More than just Infrastructure as Code",
    "More than just\nInfrastructure as Code",
    "If you've used Terraform, Pulumi, SST or the CDK, that probably looks unusual. Here's why.",
  ),
  code({
    snippet: "plain.ts",
    file: "alchemy.run.ts",
    group: "plain",
    title: "Infrastructure as Code stops at the Bucket and the Worker",
    beside: { file: "src/api.ts", src: { snippet: "what/plain-api.ts", regions: ["show"] } },
    notes:
      "Infrastructure as Code tools only cover half of that file: the Bucket and the Worker. The Worker's code is a separate program, and it finds the Bucket through an environment variable. Alchemy can be used this way too.",
  }),
  code({
    snippet: "plain.ts",
    file: "alchemy.run.ts",
    group: "plain",
    title: "The two halves meet at one name",
    beside: { file: "src/api.ts", src: { snippet: "what/plain-api.ts", regions: ["show"] } },
    links: [{ from: "env: { Uploads }", to: "env.Uploads", tone: "bad" }],
    notes:
      "The two halves meet at one name, Uploads. The handler can't see how the Bucket got there, and the infrastructure can't see what the handler does with it.",
  }),
  pyramid({
    title: "Every Infrastructure as Code tool draws this line",
    cut: CUT,
    notes:
      "Terraform, Pulumi, SST and the CDK all split an app the same way. Infrastructure and policies below the line, in one program. The code that runs above it, in another.",
  }),
  pyramid({
    title: "…but every feature crosses it",
    cut: CUT,
    slice: UPLOAD,
    notes:
      "But features don't live on one side of that line. Serving an upload needs a Bucket, access to it, a handler, and a link on the page. Every feature is split across two programs that have to agree.",
  }),
  pyramid({
    title: "In Alchemy, a feature owns both halves",
    slice: { ...UPLOAD, label: "one Effect" },
    notes:
      "Alchemy is built on Infrastructure as Code, but it doesn't stop there. When the Worker's code is an Effect that asks for the Bucket itself, one feature owns everything it needs, top to bottom.",
  }),
];

const iae: StepSpec[] = [
  slide(
    "Infrastructure as Effects",
    "Infrastructure as Effects",
    "We call this Infrastructure as Effects. Your app is built from Effects and Layers, and the infrastructure it needs is part of them. Their types record the resources it uses and the access it needs, so a missing piece is a compile error, not a failed deploy.",
  ),
  code({
    snippet: "api.ts",
    file: "src/api.ts",
    group: "phases",
    title: "The Construction phase asks for what it needs",
    tints: [{ from: "const bucket", tone: "construct" }],
    focus: { from: "const bucket" },
    notes:
      "A Worker, a Lambda Function, a Container: each one is a Runtime, a resource that carries the code it runs, and its code always has the same shape. First, ask for what you need. This runs when you deploy and again when the Worker starts. We call it the Construction phase.",
  }),
  code({
    snippet: "api.ts",
    file: "src/api.ts",
    group: "phases",
    title: "…and returns what runs on every request",
    tints: [
      { from: "const bucket", tone: "construct" },
      { from: "fetch: Effect.gen", to: '"Not found"', tone: "runtime" },
    ],
    focus: { from: "fetch: Effect.gen", to: '"Not found"' },
    notes:
      "Then return what you expose. The fetch it returns runs once per request. That's the Runtime phase.",
  }),
  code({
    snippet: "Photos.ts",
    file: "src/Photos.ts",
    group: "photos",
    title: "A service can own its infrastructure",
    fontSize: 24,
    reel: { items: ["Cloudflare", "AWS"], at: 0 },
    notes:
      "Because infrastructure is created inside Effects, a service's Layer can create what it needs. Here's a Photos service. Its Layer creates an R2 Bucket, asks for access to it, and implements upload. Any Runtime that provides this Layer gets all three.",
  }),
  code({
    snippet: "PhotosS3.ts",
    file: "src/Photos.ts",
    group: "photos",
    title: "Swap the Layer, and the photos move to S3",
    fontSize: 24,
    reel: { items: ["Cloudflare", "AWS"], at: 1 },
    notes:
      "Your business logic only sees the Photos service. Provide a different Layer, and the photos live in an S3 bucket instead, with the IAM policy to match. This is why Alchemy reaches past infrastructure into your application: workflows, APIs and domain models become Layers too.",
  }),
];

const underneath: StepSpec[] = [
  slide(
    "Underneath, it's Infrastructure as Code",
    "Underneath, it's\nInfrastructure as Code",
    "And underneath all of that, deploying works like Terraform or Pulumi.",
  ),
  code({
    snippet: "stack.ts",
    file: "alchemy.run.ts",
    group: "stack",
    title: "A Stack is what you deploy",
    notes:
      "A Stack is the unit you deploy. It creates resources, here just the Worker and the Bucket it asks for, and returns the outputs you want printed.",
  }),
  term({
    group: "cli",
    title: "alchemy deploy shows a plan, then applies only what changed",
    lines: [
      `${T.dim}$${T.reset} alchemy deploy`,
      `${T.ok}✓${T.reset} Plan ready`,
      RULE,
      `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}2 to create${T.reset}${T.dim} · ${T.reset}${T.soft}1 binding${T.reset}`,
      ``,
      `  ${T.ok}+${T.reset} ${res("Uploads", "Cloudflare.R2.Bucket")}`,
      `  ${T.ok}+${T.reset} ${res("Api", "Cloudflare.Worker")}`,
      `      ${T.soft}↳ binds Uploads${T.reset}`,
      RULE,
      `${T.ok}✓${T.reset} Uploads created`,
      `${T.ok}✓${T.reset} Api created`,
      ``,
      `${T.bold}url${T.reset}: https://myapp-api.workers.dev`,
    ],
    notes:
      "alchemy deploy reads the last result from state, compares it with your program, shows a plan, and applies only what changed. Each stage is its own copy of every resource, so dev and prod never touch each other.",
  }),
  {
    kind: "slide",
    layout: "title",
    title: "alchemy.run",
    eyebrow: "Alchemy",
    heading: "Infrastructure and app code,\ntogether",
    subtitle: "Read more at alchemy.run/what-is-alchemy",
    footer: "alchemy.run",
    notes: "That's Alchemy. The docs walk through all of this at alchemy.run/what-is-alchemy.",
  },
];

export const steps: StepSpec[] = [...opening, ...together, ...moreThanIac, ...iae, ...underneath];
