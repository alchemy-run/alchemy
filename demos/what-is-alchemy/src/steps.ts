import api from "../snippets/api.ts?raw";
import jobs from "../snippets/jobs.ts?raw";
import photos from "../snippets/Photos.ts?raw";
import photosS3 from "../snippets/PhotosS3.ts?raw";
import plainApi from "../snippets/plain-api.ts?raw";
import plain from "../snippets/plain.ts?raw";
import stack from "../snippets/stack.ts?raw";
import type { Pane, Scene, Step } from "./scene.ts";
import { cut } from "./snippet.ts";
import { color } from "./theme.ts";

/**
 * The talk, in order: the "What is Alchemy?" docs page as a sequence
 * (website/src/content/docs/what-is-alchemy.mdx). Each step is one press of →.
 */
const API: Pane = { file: "src/api.ts", code: cut(api) };
const PLAIN: Pane[] = [
  { file: "alchemy.run.ts", code: cut(plain) },
  { file: "src/api.ts", code: cut(plainApi) },
];
const GENERATED = `# IAM policy
- Effect: Allow
  Action: dynamodb:GetItem
  Resource: arn:aws:dynamodb:…:table/Jobs-a1b2c3

# environment
Jobs_tableName: Jobs-a1b2c3`;
const SLICE = {
  label: "serve an upload",
  items: ["Uploads bucket", "access · env.Uploads", "fetch handler", "download link"],
} as const satisfies Extract<Scene, { kind: "pyramid" }>["slice"];

const ok = (text: string) => ({ text, color: color.moss });
const dim = (text: string) => ({ text, color: "#6f6656" });
const plainText = (text: string) => ({ text, color: color.fg });
const bold = (text: string) => ({ text, color: color.fg, bold: true });

export const steps: Step[] = [
  {
    notes:
      "Alchemy is a TypeScript framework for building cloud applications with Effects and Layers. Your infrastructure and the code that runs on it are written together, type-checked together, and deployed together.",
    scene: {
      kind: "title",
      heading: "What is Alchemy?",
      subtitle: "Cloud applications built with Effects and Layers",
      footer: "alchemy.run",
    },
  },
  {
    title: "An R2 Bucket and a Worker that serves files from it",
    notes:
      "Here's a whole app in one file. An R2 Bucket, and a Worker that serves a file from it. The Bucket is declared right next to the Worker that uses it.",
    scene: { kind: "code", group: "api", panes: [API] },
  },
  {
    title: "The Worker asks for the Bucket in its own code",
    notes:
      "The Worker asks for the Bucket itself. This one line does two jobs. When you deploy, it gives the Worker access to the Bucket.",
    scene: {
      kind: "code",
      group: "api",
      panes: [
        {
          ...API,
          marks: [
            {
              kind: "circle",
              find: "Cloudflare.R2.ReadWriteBucket(Uploads)",
              label: "access when you deploy",
              tone: "construct",
            },
          ],
        },
      ],
    },
  },
  {
    title: "…and gets back a typed client",
    notes:
      "And when the Worker runs, the same line hands back a typed client. So bucket.get is checked by the compiler like any other function call.",
    scene: {
      kind: "code",
      group: "api",
      panes: [
        {
          ...API,
          marks: [
            {
              kind: "circle",
              find: "Cloudflare.R2.ReadWriteBucket(Uploads)",
              label: "access when you deploy",
              tone: "construct",
            },
            {
              kind: "underline",
              find: 'bucket.get("hello.txt")',
              label: "checked like any function call",
              tone: "runtime",
            },
          ],
        },
      ],
    },
  },
  {
    title: "On AWS, the same kind of line writes the IAM policy",
    notes:
      "It's the same on AWS. Ask for GetItem on the Jobs table, and Alchemy writes an IAM statement that allows exactly that call on exactly that table, and puts the table's name in the Function's environment. No name to keep in sync, no policy to write, no client to set up.",
    scene: {
      kind: "code",
      group: "aws",
      panes: [
        { file: "src/api.ts", code: cut(jobs) },
        { file: "generated at deploy", code: GENERATED, lang: "yaml" },
      ],
      links: [
        { from: "AWS.DynamoDB.GetItem(Jobs)", to: "dynamodb:GetItem", tone: "good" },
        { from: "AWS.DynamoDB.GetItem(Jobs)", to: "Jobs_tableName", tone: "good" },
      ],
    },
  },
  {
    notes:
      "If you've used Terraform, Pulumi, SST or the CDK, that probably looks unusual. Here's why.",
    scene: { kind: "section", heading: "More than just\nInfrastructure as Code" },
  },
  {
    title: "Infrastructure as Code stops at the Bucket and the Worker",
    notes:
      "Infrastructure as Code tools only cover half of that file: the Bucket and the Worker. The Worker's code is a separate program, and it finds the Bucket through an environment variable. Alchemy can be used this way too.",
    scene: { kind: "code", group: "plain", panes: PLAIN },
  },
  {
    title: "The two halves meet at one name",
    notes:
      "The two halves meet at one name, Uploads. The handler can't see how the Bucket got there, and the infrastructure can't see what the handler does with it.",
    scene: {
      kind: "code",
      group: "plain",
      panes: PLAIN,
      links: [{ from: "env: { Uploads }", to: "env.Uploads", tone: "bad" }],
    },
  },
  {
    title: "Every Infrastructure as Code tool draws this line",
    notes:
      "Terraform, Pulumi, SST and the CDK all split an app the same way. Infrastructure and policies below the line, in one program. The code that runs above it, in another.",
    scene: { kind: "pyramid", cut: true },
  },
  {
    title: "…but every feature crosses it",
    notes:
      "But features don't live on one side of that line. Serving an upload needs a Bucket, access to it, a handler, and a link on the page. Every feature is split across two programs that have to agree.",
    scene: { kind: "pyramid", cut: true, slice: SLICE },
  },
  {
    title: "In Alchemy, a feature owns both halves",
    notes:
      "Alchemy is built on Infrastructure as Code, but it doesn't stop there. When the Worker's code is an Effect that asks for the Bucket itself, one feature owns everything it needs, top to bottom.",
    scene: { kind: "pyramid", slice: { ...SLICE, label: "one Effect" } },
  },
  {
    notes:
      "We call this Infrastructure as Effects. Your app is built from Effects and Layers, and the infrastructure it needs is part of them. Their types record the resources it uses and the access it needs, so a missing piece is a compile error, not a failed deploy.",
    scene: { kind: "section", heading: "Infrastructure as Effects" },
  },
  {
    title: "The Construction phase asks for what it needs",
    notes:
      "A Worker, a Lambda Function, a Container: each one is a Runtime, a resource that carries the code it runs, and its code always has the same shape. First, ask for what you need. This runs when you deploy and again when the Worker starts. We call it the Construction phase.",
    scene: {
      kind: "code",
      group: "phases",
      panes: [{ ...API, tints: [{ from: "const bucket", tone: "construct" }] }],
    },
  },
  {
    title: "…and returns what runs on every request",
    notes:
      "Then return what you expose. The fetch it returns runs once per request. That's the Runtime phase.",
    scene: {
      kind: "code",
      group: "phases",
      panes: [
        {
          ...API,
          tints: [
            { from: "const bucket", tone: "construct" },
            { from: "fetch: Effect.gen", to: '"Not found"', tone: "runtime" },
          ],
        },
      ],
    },
  },
  {
    title: "A service can own its infrastructure",
    notes:
      "Because infrastructure is created inside Effects, a service's Layer can create what it needs. Here's a Photos service. Its Layer creates an R2 Bucket, asks for access to it, and implements upload. Any Runtime that provides this Layer gets all three.",
    scene: {
      kind: "code",
      group: "photos",
      panes: [{ file: "src/Photos.ts", code: cut(photos) }],
      reel: { items: ["Cloudflare", "AWS"], at: 0 },
    },
  },
  {
    title: "Swap the Layer, and the photos move to S3",
    notes:
      "Your business logic only sees the Photos service. Provide a different Layer, and the photos live in an S3 bucket instead, with the IAM policy to match. This is why Alchemy reaches past infrastructure into your application: workflows, APIs and domain models become Layers too.",
    scene: {
      kind: "code",
      group: "photos",
      panes: [{ file: "src/Photos.ts", code: cut(photosS3) }],
      reel: { items: ["Cloudflare", "AWS"], at: 1 },
    },
  },
  {
    notes: "And underneath all of that, deploying works like Terraform or Pulumi.",
    scene: { kind: "section", heading: "Underneath, it's\nInfrastructure as Code" },
  },
  {
    title: "A Stack is what you deploy",
    notes:
      "A Stack is the unit you deploy. It creates resources, here the Worker and the Bucket it asks for, and returns the outputs you want printed.",
    scene: { kind: "code", group: "stack", panes: [{ file: "alchemy.run.ts", code: cut(stack) }] },
  },
  {
    title: "alchemy deploy shows a plan, then applies only what changed",
    notes:
      "alchemy deploy reads the last result from state, compares it with your program, shows a plan, and applies only what changed. Each stage is its own copy of every resource, so dev and prod never touch each other.",
    frames: 60,
    scene: {
      kind: "terminal",
      lines: [
        [dim("$ "), plainText("alchemy deploy")],
        [ok("✓ "), plainText("Plan ready")],
        [dim("─".repeat(48))],
        [
          { text: "Deploy", color: color.ember, bold: true },
          dim(" · "),
          ok("2 to create"),
          dim(" · "),
          ok("1 binding"),
        ],
        [],
        [ok("  + "), bold("Uploads "), dim("(Cloudflare.R2.Bucket)")],
        [ok("  + "), bold("Api "), dim("(Cloudflare.Worker)")],
        [ok("      ↳ binds Uploads")],
        [dim("─".repeat(48))],
        [ok("✓ "), plainText("Uploads created")],
        [ok("✓ "), plainText("Api created")],
        [],
        [bold("url"), plainText(": https://myapp-api.workers.dev")],
      ],
    },
  },
  {
    notes: "That's Alchemy. The docs walk through all of this at alchemy.run/what-is-alchemy.",
    scene: {
      kind: "title",
      heading: "Infrastructure and app code,\ntogether",
      subtitle: "alchemy.run/what-is-alchemy",
      footer: "alchemy.run",
    },
  },
];

const DEFAULT_FRAMES = 36;

/** Each step's frames `[from, to)` on the composition's timeline. */
export const ranges = steps.reduce<{ from: number; to: number }[]>((acc, step) => {
  const from = acc.at(-1)?.to ?? 0;
  acc.push({ from, to: from + (step.frames ?? DEFAULT_FRAMES) });
  return acc;
}, []);
export const totalFrames = ranges.at(-1)!.to;
