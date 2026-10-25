import type { Step } from "./scene.ts";

/**
 * The talk, in order. Its content is the "What is Alchemy?" docs page
 * (website/src/content/docs/what-is-alchemy.mdx) and the compare page
 * (website/src/pages/compare.astro). Each step is one press of →.
 */
export const steps: Step[] = [
  {
    notes:
      "Alchemy is a TypeScript framework for building cloud applications with Effects and Layers. Your infrastructure and the code that runs on it are written together, type-checked together, and deployed together.",
    scene: {
      kind: "hero",
      eyebrow: "What is Alchemy?",
      heading: "More than just\nInfrastructure as Code",
      lede: "A TypeScript framework for cloud applications, built with Effects and Layers. Infrastructure and the code that runs on it, written, type-checked and deployed together.",
    },
  },
  {
    heading: "Infrastructure and app code, together",
    notes:
      "Here's an R2 Bucket and a Worker that serves a file from it, written the way Terraform, Pulumi, SST or the CDK would have you write it. One program creates the Bucket and the Worker. The Worker's code is a second program that finds the Bucket through an environment variable.",
    scene: { kind: "versus", stage: 1 },
  },
  {
    heading: "Infrastructure and app code, together",
    notes:
      "The two programs meet at one name, Uploads. The handler can't see how the Bucket got there, and the infrastructure can't see what the handler does with it. Every feature you build has to change both, and they have to agree.",
    scene: { kind: "versus", stage: 2 },
  },
  {
    heading: "Infrastructure and app code, together",
    notes:
      "In Alchemy it's one file. The Bucket is declared next to the Worker, and the Worker asks for it in its own code. That one line gives the Worker access when you deploy, and hands back a typed client while it runs. Alchemy still deploys the two-program version, so existing handlers work as they are.",
    scene: { kind: "versus", stage: 3 },
  },
  {
    heading: "One line does three jobs",
    lede: "To read a table, a function needs a permission, the table's name, and a client.",
    notes: "Here's the same idea on AWS. A Lambda asks for GetItem on the Jobs table.",
    scene: { kind: "oneLine", stage: 1 },
  },
  {
    heading: "One line does three jobs",
    lede: "To read a table, a function needs a permission, the table's name, and a client.",
    notes:
      "That one line produces all three: a statement in the IAM policy, the table's name in the environment, and a typed client. No name to keep in sync, no policy to write, no client to set up.",
    scene: { kind: "oneLine", stage: 2 },
  },
  {
    heading: "Least privilege, from the code",
    lede: "Permissions come from the bindings your code uses.",
    notes:
      "Because the policy comes from the code, it grants exactly what the code calls: GetItem on that table. SST's link grants every DynamoDB action on the table. Pulumi and Terraform deploy whatever policy you write, which is often dynamodb:* on everything.",
    scene: { kind: "permissions" },
  },
  {
    heading: "Infrastructure as Effects",
    lede: "A Runtime's code asks for what it needs, then returns what runs.",
    notes:
      "We call this Infrastructure as Effects. A Worker, a Lambda Function or a Container is a Runtime, and its code always has the same shape. First it asks for what it needs. That's the Construction phase. It runs when you deploy, and again when the Worker starts.",
    scene: { kind: "phases", stage: 1 },
  },
  {
    heading: "Infrastructure as Effects",
    lede: "A Runtime's code asks for what it needs, then returns what runs.",
    notes:
      "Then it returns what it exposes. The fetch handler runs once per request. That's the Runtime phase. Both live in one Effect, so the types know every resource it uses and every access it needs: leave one out and it doesn't compile.",
    scene: { kind: "phases", stage: 2 },
  },
  {
    heading: "Your services own their infrastructure",
    notes:
      "Because infrastructure is created inside Effects, a service's Layer can create what it needs. JobServiceKV creates a KV Namespace, asks for access to it, and implements getJob. Any Runtime that provides the Layer gets all three.",
    scene: { kind: "layers", variant: "kv" },
  },
  {
    heading: "Your services own their infrastructure",
    notes:
      "Your business logic only sees JobService. Provide a different Layer and the jobs live in a DynamoDB table instead, with the IAM policy to match. This is why Alchemy reaches past infrastructure into your application: workflows, APIs and domain models are Layers too.",
    frames: 48,
    scene: { kind: "layers", variant: "dynamo" },
  },
  {
    heading: "Underneath, it's Infrastructure as Code",
    lede: "Its own engine in TypeScript, not a wrapper.",
    notes:
      "Underneath, deploying works like Terraform or Pulumi, with one difference. SST, Pulumi and Terraform talk to their providers over a bridge, sometimes two. Alchemy imports its providers as TypeScript and runs them directly.",
    scene: { kind: "engine" },
  },
  {
    heading: "Underneath, it's Infrastructure as Code",
    lede: "alchemy deploy shows a plan, then applies only what changed.",
    notes:
      "A Stack is what you deploy. alchemy deploy reads the last result from state, compares it with your program, shows a plan, and applies only what changed. Each stage is its own copy of every resource, so dev and prod never touch each other.",
    frames: 72,
    scene: { kind: "deploy" },
  },
  {
    heading: "True emulation for faster dev loops",
    notes:
      "Back on your machine. alchemy dev runs the whole stack locally: the Lambda in Docker, DynamoDB in an emulator. A request never leaves your laptop.",
    scene: { kind: "dev", stage: 1 },
  },
  {
    heading: "True emulation for faster dev loops",
    notes:
      "And you choose what's real. Pipe the Lambda through remote() and it's deployed for real, while it still reads and writes your local DynamoDB.",
    frames: 48,
    scene: { kind: "dev", stage: 2 },
  },
  {
    heading: "True emulation for faster dev loops",
    notes:
      "Compare that with SST, where every request goes through a deployed stage, three round trips across the network. And Pulumi and Terraform have no local runtime at all: every change is a redeploy.",
    scene: { kind: "dev", stage: 3 },
  },
  {
    heading: "A complete iteration loop for agents",
    lede: "Deploy a real stack, test it, and tear it down, from the test runner you already use.",
    notes:
      "When it works locally, the same test deploys the app to a stage of its own, runs against real infrastructure, and destroys it. Our preview benchmark does one full loop in about 17 seconds. An agent makes a change and runs one test file.",
    frames: 84,
    scene: { kind: "loop" },
  },
  {
    heading: "At a glance",
    notes: "Here's all of it side by side.",
    frames: 48,
    scene: { kind: "glance" },
  },
  {
    notes: "That's Alchemy. Read more at alchemy.run/what-is-alchemy.",
    scene: {
      kind: "hero",
      eyebrow: "Alchemy",
      heading: "Infrastructure and app code,\ntogether",
      lede: "Built on Infrastructure as Code, written with Effects and Layers.",
      footer: "alchemy.run/what-is-alchemy",
    },
  },
];

const DEFAULT_FRAMES = 40;

/** Each step's frames `[from, to)` on the composition's timeline. */
export const ranges = steps.reduce<{ from: number; to: number }[]>((acc, step) => {
  const from = acc.at(-1)?.to ?? 0;
  acc.push({ from, to: from + (step.frames ?? DEFAULT_FRAMES) });
  return acc;
}, []);
export const totalFrames = ranges.at(-1)!.to;
