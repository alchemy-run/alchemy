/**
 * The intro, as authored. Each entry is one press of → in the presenter;
 * `title` is the caption at the bottom of the screen and `notes` is the
 * talk track. `intro/build.ts` resolves this into `out/capture/intro/intro.json`.
 *
 * Code comes from `snippets/` (real files, type-checked; `*.error.ts` must
 * fail and their real errors are shown) or inline `code` for the imagined
 * language. Boards are drawn by `remotion/intro/boards.tsx`.
 */
import type { MiniGraph, PanelItem, Tone } from "../shared/intro.ts";

/** Where in the code: the first match of `text` (or the `nth`, 1-based). */
export type Find = string | { text: string; nth?: number };

export type Source = { snippet: string; regions?: string[] } | { code: string };

export interface CodeSpec {
  kind: "code";
  title: string;
  notes?: string;
  group: string;
  file?: string;
  pseudo?: boolean;
  src: Source;
  fontSize?: number;
  /** Tint lines by phase: a snippet region, or the lines from one match to another. */
  tints?: (({ region: string } | { from: Find; to?: Find }) & { tone: Tone })[];
  focus?: { from: Find; to?: Find };
  marks?: {
    kind: "circle" | "underline" | "strike" | "box" | "highlight";
    find: Find;
    /** For boxes spanning lines: the last line (found by text). */
    to?: Find;
    label?: string;
    side?: "right" | "left" | "above" | "below";
    tone?: Tone;
  }[];
  /** For `*.error.ts` snippets: which lines of the compiler's message to show. */
  error?: { pick?: (lines: string[]) => string[] };
  panel?: { title: string; items: PanelItem[] };
  /** A drawing beside the code that evolves with it. */
  diagram?: MiniGraph;
  frames?: number;
}

export interface SlideSpec {
  kind: "slide";
  title: string;
  notes?: string;
  layout?: "title" | "section";
  eyebrow?: string;
  heading: string;
  subtitle?: string;
  frames?: number;
}

export interface BoardSpec {
  kind: "board";
  title: string;
  notes?: string;
  board: string;
  stage: number;
  frames?: number;
}

export type StepSpec = CodeSpec | SlideSpec | BoardSpec;

const policy = (action: string) => `{
  "Effect": "Allow",
  "Action": "${action}",
  "Resource": "arn:aws:s3:::uploads-7f3a/*"
}`;

/** The compiler's message lines that name the missing requirement. */
const requirementLines = (needle: string) => (lines: string[]) => {
  const at = lines.findIndex((line) => line.includes(needle));
  return at < 0 ? lines.slice(0, 2) : lines.slice(Math.max(1, at - 1), at + 1);
};


// ── Act 1 & 2: one program in an imaginary cloud language ────────────────
// The code on the left grows one idea at a time; the drawing on the right
// shows what that code means in the cloud.
const C = {
  bucket: { id: "bucket", title: "Bucket", color: "#8b7cf6" },
  queue: { id: "queue", title: "Queue", color: "#e0a86b" },
  api: { id: "api", title: "Function", color: "#f38020" },
};
const FN = `

async function api(req) {
  const file = await bucket.get(req.key)
  await queue.send(file)
}`;
const VERSIONED = `const bucket = Bucket({ versioning: true })
const queue = Queue()${FN}`;
const COLORED_APP = `construct app() {
  const bucket = Bucket({ versioning: true })
  const queue = Queue()

  runtime async function api(req) {
    const file = await bucket.get(req.key)
    await queue.send(file)
  }
}`;
const COLORED_BAD = COLORED_APP.replace(
  "    const file = await bucket.get(req.key)",
  "    const other = Bucket()\n    const file = await bucket.get(req.key)",
);

const at = (node: { id: string; title: string; color: string }, x: number, y: number, notes?: string[]) => ({
  ...node,
  x,
  y,
  ...(notes ? { notes } : {}),
});
/** The program's graph; `env` lists variables injected into the Function. */
const GRAPH = (notes?: string[], env?: string[]) => [
  at(C.api, 125, 270, env),
  at(C.bucket, 590, 100, notes),
  at(C.queue, 590, 440),
];
const USES = [{ from: "api", to: "bucket" }];
/** A binding: the connection carries its permission, and the Function gets an env var. */
const GET = { from: "api", to: "bucket", tone: "construct" as const, label: "s3:GetObject" };
const SEND = { from: "api", to: "queue", tone: "construct" as const, label: "sqs:SendMessage" };
const BINDINGS = [GET, SEND];
const ENV = ["$BUCKET_NAME", "$QUEUE_URL"];
const lang = (spec: Omit<CodeSpec, "kind" | "group" | "pseudo" | "fontSize">): CodeSpec => ({
  kind: "code",
  group: "lang",
  pseudo: true,
  fontSize: 32,
  ...spec,
});
const phaseTints = [
  { from: "const bucket", to: "const queue", tone: "construct" as const },
  { from: "const file", to: "await queue.send", tone: "runtime" as const },
];

const B1 = "const bucket = Bucket()";
const B2 = "const bucket = Bucket({ versioning: true })";
const BQ = `${B2}
const queue = Queue()`;
const EMPTY_FN = `${BQ}

async function api(req) {
}`;
const GET_FN = `${BQ}

async function api(req) {
  const file = await bucket.get(req.key)
}`;

const program = (): StepSpec[] => [
  lang({
    title: "In a cloud language, a variable can be a resource",
    src: { code: B1 },
    diagram: { nodes: [at(C.bucket, 360, 150)], edges: [] },
    notes:
      "Imagine a programming language for the cloud. Declaring a bucket doesn't allocate memory: it creates a real bucket in the cloud.",
  }),
  lang({
    title: "Change the code, and the cloud is reconciled to match",
    src: { code: B2 },
    diagram: { nodes: [at(C.bucket, 360, 150, ["versioning: on"])], edges: [] },
    notes:
      "Resources have configuration that changes over time. Turn on versioning in the code, and the language reconciles the real bucket to match.",
  }),
  lang({
    title: "Resources outlive the program that declares them",
    src: { code: BQ },
    diagram: { nodes: [at(C.bucket, 590, 100, ["versioning: on"]), at(C.queue, 590, 440)], edges: [] },
    notes:
      "An ordinary program runs from start to finish and its state is gone. These don't go away when the program ends: they're a persistent world, and the next run starts from it.",
  }),
  lang({
    title: "A function is a resource too",
    src: { code: EMPTY_FN },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [] },
    notes: "Declaring a function deploys it: another node in the world.",
  }),
  lang({
    title: "Reading the bucket connects the function to it",
    src: { code: GET_FN },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [USES[0]!] },
    notes: "Call bucket.get inside the function, and the function now depends on the bucket.",
  }),
  lang({
    title: "The call needs permission to read the bucket",
    src: { code: GET_FN },
    marks: [{ kind: "circle", find: "bucket.get(req.key)", tone: "construct" }],
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [GET] },
    notes: "For the function to call bucket.get, it needs an IAM policy that allows s3:GetObject on this bucket.",
  }),
  lang({
    title: "…and the bucket's name, as an environment variable",
    src: { code: GET_FN },
    marks: [{ kind: "circle", find: "bucket.get(req.key)", tone: "construct" }],
    diagram: { nodes: GRAPH(["versioning: on"], [ENV[0]!]), edges: [GET] },
    notes:
      "And it needs to know which bucket: its name is injected as an environment variable. The permission plus the configuration is what we call a binding.",
  }),
  lang({
    title: "Sending to the queue creates another binding",
    src: { code: VERSIONED },
    marks: [{ kind: "circle", find: "queue.send(file)", tone: "construct" }],
    diagram: { nodes: GRAPH(["versioning: on"], ENV), edges: BINDINGS },
    notes: "Same again for the queue: sqs:SendMessage, and the queue's URL in an environment variable.",
  }),
  lang({
    title: "The language infers every binding from the code",
    src: { code: VERSIONED },
    marks: [
      { kind: "circle", find: "bucket.get(req.key)", tone: "construct" },
      { kind: "circle", find: "queue.send(file)", tone: "construct" },
    ],
    diagram: { nodes: GRAPH(["versioning: on"], ENV), edges: BINDINGS },
    notes:
      "A cloud language derives all of this by static analysis. Nobody writes policies or environment variables by hand: the program is a graph of resources, and the code is the source of truth for how they connect.",
  }),
  lang({
    title: "The program runs in two phases",
    src: { code: VERSIONED },
    tints: [
      { from: "const bucket", to: "const queue", tone: "construct" },
      { from: "const file", to: "await queue.send", tone: "runtime" },
    ],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      frame: { label: "construction", tone: "construct" },
      incoming: { to: "api", label: "runtime · each request", tone: "runtime" },
    },
    notes:
      "So the program doesn't run once from top to bottom. Construction is declarative: it builds the architecture, the resources and bindings. Runtime is imperative: the function body runs on every request, using what construction declared.",
  }),
  lang({
    title: "Imagine the phases as colored functions",
    src: { code: COLORED_APP },
    tints: phaseTints,
    diagram: { nodes: GRAPH(["versioning: on"], ENV), edges: BINDINGS },
    notes:
      "In a real language we could make that explicit with colored functions: a construct function builds resources, and a runtime function inside it uses them.",
  }),
  lang({
    title: "The colors are boundaries the compiler enforces",
    src: { code: COLORED_BAD },
    tints: [
      { from: "const bucket", to: "const queue", tone: "construct" },
      { from: "const other", to: "await queue.send", tone: "runtime" },
    ],
    marks: [{ kind: "strike", find: "Bucket()", tone: "bad" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      cards: [{ text: "✗ can't create a resource at runtime", tone: "bad" }],
    },
    notes: "Construct and runtime can't call each other the wrong way: creating a bucket inside a request is a compile error.",
  }),
  lang({
    title: "Inferring bindings is a kind of type checking",
    src: { code: COLORED_APP },
    tints: phaseTints,
    marks: [{ kind: "circle", find: "bucket.get(req.key)", tone: "runtime" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      labels: [{ text: "for every possible req…", x: 360, y: 530, tone: "runtime" }],
    },
    notes:
      "Inferring the bindings is like type checking: analyze what the runtime function can do over every input it accepts, the same way a compiler infers a return type.",
  }),
];

export const steps: StepSpec[] = [
  // Act 1: a programming language for the cloud
  {
    kind: "slide",
    layout: "title",
    title: "A programming language for the cloud",
    eyebrow: "Alchemy",
    heading: "A programming language for the cloud",
    subtitle: "…without building a new language. Yet.",
    notes:
      "The idea underneath Alchemy: a programming language for the cloud, without actually building a new language (at least not yet).",
  },
  ...program(),

  // Act 3: how we tried before
  {
    kind: "board",
    board: "history",
    stage: 0,
    title: "I've tried to build this before",
    notes: "Before Alchemy I tried this more than once.",
  },
  {
    kind: "code",
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "Punchcard: two phases on top of the AWS CDK",
    src: {
      code: `const topic = new SNS.Topic(stack, 'Topic', {
  shape: NotificationRecord
});

new Lambda.Function(stack, 'MyFunction', {
  depends: topic,
}, async (event, topic) => {
  await topic.publish(new NotificationRecord({
    key: 'some key',
    count: 1,
    timestamp: new Date()
  }));
});`,
    },
    tints: [
      { from: "const topic", to: "depends: topic", tone: "construct" },
      { from: "async (event", to: "}));", tone: "runtime" },
    ],
    notes:
      "In 2018 and 2019 I built Punchcard on top of the AWS CDK. It modeled the two phases: declare a topic, depend on it from a Function, and get a typed client at runtime with the IAM policy generated for you.",
  },
  {
    kind: "code",
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "…but the runtime shipped with all of the infrastructure code",
    src: {
      code: `const topic = new SNS.Topic(stack, 'Topic', {
  shape: NotificationRecord
});

new Lambda.Function(stack, 'MyFunction', {
  depends: topic,
}, async (event, topic) => {
  await topic.publish(new NotificationRecord({
    key: 'some key',
    count: 1,
    timestamp: new Date()
  }));
});`,
    },
    tints: [
      { from: "const topic", to: "depends: topic", tone: "construct" },
      { from: "async (event", to: "}));", tone: "runtime" },
    ],
    marks: [{ kind: "circle", find: "SNS.Topic", label: "brings the CDK with it", side: "right", tone: "bad" }],
    panel: {
      title: "What the Lambda bundle contains",
      items: [
        { title: "Your handler", bar: 0.04, tone: "runtime" },
        { title: "Punchcard", bar: 0.3, tone: "bad" },
        { title: "The AWS CDK", bar: 1, tone: "bad" },
      ],
    },
    notes:
      "The problem: it was coupled to the CDK. Importing the Topic imported everything needed to provision it, so bundling hacks had to strip the CDK out of the runtime, and serverless apps still shipped a massive amount of bloat. (Sizes illustrative.)",
  },
  {
    kind: "code",
    group: "functionless",
    file: "functionless · workflow.ts",
    title: "Functionless: compile TypeScript by reading its AST",
    src: {
      code: `export default StepFunction(async (input: { todoId: string }) => {
  await StepFunction.waitSeconds(10);

  await MyDatabase.attributes.delete({
    Key: {
      pk: { S: "todo" },
      sk: { S: input.todoId },
    },
  });
});`,
    },
    marks: [{ kind: "circle", find: "MyDatabase", label: "found by walking the AST", side: "right", tone: "bad" }],
    panel: {
      title: "What it took",
      items: [
        { title: "A compiler plugin", body: "to capture every function's AST" },
        { title: "Bundling hacks", body: "to keep the AST around at runtime" },
        { title: "Walking lexical scope", body: "to find the resources a function touches" },
      ],
    },
    notes:
      "Then Functionless: more bundling hacks, this time to make the AST available at runtime so code could walk it, including variables captured from the lexical scope, to infer bindings and permissions.",
  },
  {
    kind: "slide",
    layout: "section",
    title: "A square peg in a round hole",
    eyebrow: "The lesson",
    heading: "A square peg in a round hole",
    subtitle: "Don't fight your language.",
    notes: "Both bent a language into doing something it was never designed to do.",
  },

  // Act 4: Effect is the missing piece
  {
    kind: "code",
    group: "effect",
    title: "Effect<A, Err, Req>",
    src: { code: "Effect<A, Err, Req>" },
    fontSize: 96,
    marks: [
      { kind: "underline", find: "A", label: "what it returns", side: "above", tone: "neutral" },
      { kind: "underline", find: "Err", label: "how it fails", side: "below", tone: "neutral" },
      { kind: "circle", find: "Req", label: "what it needs", side: "above", tone: "construct" },
    ],
    notes: "Effect is what unlocked the path forward. Look at Effect's type: success, errors, and the requirements channel.",
  },
  {
    kind: "code",
    group: "effect",
    title: "Req: what a function needs from the outside world",
    src: {
      code: `// what goes in, and what comes out
function get(key: string): Promise<Buffer>

// …and what it needs from the outside world
function get(key: string): Effect<Buffer, NoSuchKey, GetObject>`,
    },
    marks: [{ kind: "circle", find: { text: "GetObject", nth: 1 }, label: "Req", side: "below", tone: "construct" }],
    notes:
      "A function signature usually captures its input and output. The Req channel captures something else: the function's external dependencies.",
  },
  {
    kind: "code",
    group: "peek",
    title: "Static analysis has to look inside the function",
    src: {
      code: `function get(key: string): Promise<Buffer> {
  return s3.getObject({ Bucket: BUCKET_NAME, Key: key })
}`,
    },
    marks: [{ kind: "box", find: "return s3.getObject({ Bucket: BUCKET_NAME, Key: key })", label: "hidden in the body", side: "below", tone: "bad" }],
    notes:
      "When you build static analysis to infer bindings, the first wall is that you have to peek inside a function to see what it accesses. That breaks encapsulation.",
  },
  {
    kind: "code",
    group: "peek",
    title: "So lift the dependency into the type",
    src: {
      code: `function get(key: string): Effect<Buffer, NoSuchKey, GetObject> {
  return getObject({ Key: key })
}`,
    },
    marks: [{ kind: "circle", find: "GetObject", label: "now it's in the signature", side: "below", tone: "good" }],
    notes:
      "Type systems have the answer: instead of peeking inside, lift the property into the type signature. That's exactly what the Req channel does.",
  },
  {
    kind: "board",
    board: "layers",
    stage: 0,
    title: "Context.Service and Layer separate interface from implementation",
    notes:
      "The next piece: Context.Service and Layer solve the coupling problem Punchcard had. Code depends on a service's interface; a Layer implements it; they only meet where you provide it.",
  },
  {
    kind: "code",
    group: "worker",
    file: "src/Api.ts",
    title: "yield* a resource, and you require its provider",
    src: { snippet: "worker.ts", regions: ["show"] },
    tints: [{ region: "construct", tone: "construct" }],
    marks: [
      { kind: "circle", find: 'AWS.S3.Bucket("Uploads")', label: "requires the S3 Bucket provider", side: "right", tone: "construct" },
    ],
    notes:
      "Alchemy uses this for resource providers. yield* a Bucket and you take on a requirement for its provider…",
  },
  {
    kind: "code",
    group: "stack",
    file: "alchemy.run.ts",
    title: "Only the Stack satisfies it, so providers never ship in the Worker",
    src: { snippet: "stack.ts", regions: ["show"] },
    marks: [
      { kind: "box", find: "providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers())", label: "satisfied here, at deploy time only", side: "above", tone: "construct" },
    ],
    notes:
      "…but that requirement only has to be satisfied on the Stack, not on the Worker. The Stack isn't part of the runtime bundle, so provisioning stays type-safe without coupling the Worker to it.",
  },
  {
    kind: "code",
    group: "binding",
    file: "src/Api.ts",
    title: "A binding is a declaration",
    src: { snippet: "worker.ts", regions: ["show"] },
    tints: [{ region: "construct", tone: "construct" }],
    marks: [
      { kind: "circle", find: "AWS.S3.GetObject(bucket)", label: "what the Worker may do, not how", side: "right", tone: "construct" },
    ],
    notes: "Bindings work the same way. AWS.S3.GetObject(bucket) is a declaration. It says nothing about how it's implemented.",
  },
  {
    kind: "code",
    group: "binding",
    file: "src/Api.ts",
    title: "The type system makes you provide an implementation",
    src: { snippet: "missing-provide.error.ts", regions: ["show"] },
    tints: [{ region: "construct", tone: "construct" }],
    error: { pick: requirementLines("Type 'GetObject'") },
    notes: "Leave out the implementation and it doesn't compile: GetObject is an unsatisfied requirement.",
  },
  {
    kind: "code",
    group: "binding",
    file: "src/Api.ts",
    title: "Provide one: Http means over Alchemy's HTTP SDK",
    src: { snippet: "worker.ts", regions: ["show"] },
    tints: [{ region: "construct", tone: "construct" }],
    marks: [{ kind: "underline", find: "AWS.S3.GetObjectHttp", label: "the implementation", side: "above", tone: "good" }],
    notes:
      "Effect.provide(AWS.S3.GetObjectHttp): the Http suffix names the implementation, here Alchemy's Distilled SDK over HTTP.",
  },
  {
    kind: "board",
    board: "fork",
    stage: 0,
    title: "The implementation wires up the permissions too",
    notes:
      "The layer also wires up permissions. On Lambda it adds a least-privilege statement to the Function's role. On a Cloudflare Worker, or anywhere outside AWS, it creates an IAM user that can only assume a role, and gives the Worker the keys to fetch short-lived credentials at runtime.",
  },
  {
    kind: "code",
    group: "binding",
    file: "src/Api.ts",
    title: "Least privilege, by construction",
    src: { snippet: "put-object.ts", regions: ["show"] },
    tints: [{ region: "construct", tone: "construct" }],
    marks: [{ kind: "highlight", find: "AWS.S3.PutObject(bucket)", label: "one new line…", side: "right", tone: "good" }],
    panel: {
      title: "…one new statement",
      items: [
        { title: "s3:GetObject", mono: policy("s3:GetObject") },
        { title: "s3:PutObject", mono: policy("s3:PutObject"), tone: "good" },
      ],
    },
    notes:
      "Because bindings are granular, you can't call a cloud API without declaring it. Need to write objects? Declare PutObject. Permissions grow with the application, never ahead of it.",
  },

  // Act 5: the compiler
  {
    kind: "board",
    board: "pipeline",
    stage: 0,
    title: "alchemy deploy is the compiler, without static analysis",
    notes:
      "alchemy deploy acts as the compiler of your application. TypeScript does the static analysis with Effect and Layer types; running the program just builds the graph of resources and bindings, which is diffed into a plan you review.",
  },

  // Act 6: components
  {
    kind: "board",
    board: "components",
    stage: 0,
    title: "Infrastructure components have existed for years",
    notes: "Terraform modules, CDK constructs, Pulumi components: you've been able to package infrastructure for a long time.",
  },
  {
    kind: "board",
    board: "components",
    stage: 1,
    title: "But they can't include the code that uses them",
    notes:
      "But it's only infrastructure. The runtime code can't be encapsulated with it, so you can't ship an application-facing component that brings its own infrastructure.",
  },
  {
    kind: "code",
    group: "links",
    file: "src/Links.ts",
    title: "In Alchemy, a component is just a Layer",
    src: { snippet: "links.ts", regions: ["service", "layer"] },
    tints: [
      { from: "const db = yield*", to: "const sql = yield*", tone: "construct" },
      { from: "return linksOver", tone: "runtime" },
    ],
    notes:
      "In Alchemy a component is a Layer: a Context.Service interface, and a Layer.effect that declares its resources and bindings in the construction phase and returns the runtime interface.",
  },
  {
    kind: "code",
    group: "app",
    file: "src/Shorty.ts",
    title: "The application depends only on the interface",
    src: { snippet: "app-d1.ts", regions: ["show"] },
    marks: [{ kind: "circle", find: "yield* Links", label: "just the interface", side: "right", tone: "construct" }],
    notes: "Business logic is written against the Links interface.",
  },
  {
    kind: "code",
    group: "app",
    file: "src/Shorty.ts",
    title: "Swap the infrastructure, keep the business logic",
    src: { snippet: "app-neon.ts", regions: ["show"] },
    marks: [{ kind: "underline", find: "LinksNeon", label: "D1 → Neon Postgres", side: "above", tone: "good" }],
    notes: "Swap the Layer and the infrastructure changes underneath: D1, Neon, DynamoDB. The business logic doesn't change. We'll do this for real in the demo.",
  },

  // Act 7: the colors, in the type system
  {
    kind: "code",
    group: "real-colors",
    file: "src/Api.ts",
    title: "The same colors, in real code",
    src: { snippet: "runtime.ts", regions: ["show"] },
    tints: [
      { from: "Effect.gen(function* () {", to: "Cloudflare.R2.ReadBucket(bucket)", tone: "construct" },
      { from: "fetch: Effect.gen", to: "}).pipe(Effect.orDie),", tone: "runtime" },
    ],
    notes:
      "Back to colored functions. In Alchemy the two phases are a convention: the Worker's constructor is construction, fetch is runtime. And TypeScript can check it.",
  },
  {
    kind: "code",
    group: "real-colors",
    file: "src/Api.ts",
    title: "Runtime calls need RuntimeContext, which the constructor doesn't have",
    src: { snippet: "call-in-constructor.error.ts", regions: ["show"] },
    tints: [
      { from: "Effect.gen(function* () {", to: 'uploads.get("README.md").pipe', tone: "construct" },
      { from: "fetch: Effect.gen", to: "}).pipe(Effect.orDie),", tone: "runtime" },
    ],
    marks: [{ kind: "strike", find: 'uploads.get("README.md").pipe', tone: "bad" }],
    error: { pick: requirementLines("Type 'RuntimeContext'") },
    notes:
      "Runtime methods require Alchemy.RuntimeContext, and Workers don't allow it in their constructor, which runs at deploy time and at cold start. Call a binding there and it's a type error. It's Req, emulating colored functions.",
  },
  {
    kind: "code",
    group: "real-colors",
    file: "src/Api.ts",
    title: "The escape hatch is explicit, like ts-expect-error",
    src: { snippet: "phantom.ts", regions: ["show"] },
    tints: [
      { from: "Effect.gen(function* () {", to: 'uploads.get("README.md").pipe', tone: "construct" },
      { from: "fetch: Effect.gen", to: "}).pipe(Effect.orDie),", tone: "runtime" },
    ],
    marks: [{ kind: "box", find: "Alchemy.RuntimeContext.phantom", label: "opt in, visibly", side: "right", tone: "neutral" }],
    notes:
      "You can still make the call, but only by reaching for the escape hatch, RuntimeContext.phantom: an explicit opt-in that squashes the error, like ts-expect-error.",
  },
  {
    kind: "code",
    group: "future",
    pseudo: true,
    title: "Today a DSL in TypeScript. Tomorrow, a syntax",
    src: { code: COLORED_APP },
    fontSize: 40,
    tints: phaseTints,
    notes:
      "This all serves the original goal: a cloud programming language without new syntax. The TypeScript and Effect DSL is the foundation that a real syntax, with first-class colored functions, can sit on later. Now let's build something.",
  },
];
