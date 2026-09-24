/**
 * The intro, as authored. Each entry is one press of → in the presenter;
 * `title` is the caption at the bottom of the screen and `notes` is the
 * talk track. `intro/build.ts` resolves this into `out/capture/intro/intro.json`.
 *
 * Code comes from `snippets/` (real files, type-checked; `*.error.ts` must
 * fail and their real errors are shown) or inline `code` for the imagined
 * language. Boards are drawn by `remotion/intro/boards.tsx`.
 */
import type { Drill, MiniGraph, PanelItem, ReqItem, ReqPanel, Tone } from "../shared/intro.ts";

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
  lang?: "typescript" | "yaml" | "ansi";
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
    /** Set the label further away, with an arrow pointing at the mark. */
    arrow?: boolean;
  }[];
  /**
   * For `*.error.ts` snippets: which lines of the compiler's message to show,
   * or `hide` to show the (still failing) code before the error is revealed.
   */
  error?: { pick?: (lines: string[]) => string[]; hide?: boolean };
  panel?: { title: string; items: PanelItem[] };
  /** A drawing beside the code that evolves with it. */
  diagram?: MiniGraph;
  /** A value passed down a call chain, drawn beside the code. */
  drill?: Drill;
  /** The code's requirements (Effect's Req), listed beside it. */
  req?: ReqPanel;
  /** A second file shown side by side, on the right. */
  beside?: Pick<CodeSpec, "file" | "src" | "lang" | "tints" | "marks">;
  /** Lines from text in this file to text in `beside`. */
  links?: { from: Find; to: Find; tone?: Tone }[];
  /** A hand-written aside in the bottom-right corner. */
  aside?: { text: string; tone?: Tone; image?: string };
  /** Don't highlight or spotlight the lines that changed since the previous step. */
  quiet?: boolean;
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

function api(req) {
  const file = bucket.get(req.key)
  queue.send(file)
}`;
const VERSIONED = `const bucket = Bucket({ versioning: true })
const queue = Queue()${FN}`;
const COLORED_APP = `construct app() {
  const bucket = Bucket({ versioning: true })
  const queue = Queue()

  runtime function api(req) {
    const file = bucket.get(req.key)
    queue.send(file)
  }
}`;
/** Step one of the colors: only construction is marked. */
const CONSTRUCT_ONLY = COLORED_APP.replace("  runtime function api(req) {", "  function api(req) {");
/** The question: what would a bucket created inside the function even mean? */
const SCRATCH = VERSIONED.replace(
  "  const file = bucket.get(req.key)",
  "  const scratch = Bucket()\n  const file = bucket.get(req.key)",
);
const SCRATCH_NODE = { id: "scratch", title: "Bucket?", color: "#ff7b72", x: 360, y: 610, ghost: true };
const COLORED_BAD = COLORED_APP.replace(
  "    const file = bucket.get(req.key)",
  "    const scratch = Bucket()\n    const file = bucket.get(req.key)",
);

/** The mirror mistake: calling runtime code during construction. */
const COLORED_EARLY = COLORED_APP.replace(
  "  const queue = Queue()\n",
  '  const queue = Queue()\n  bucket.get("hello.txt")\n',
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
const lang = (spec: Omit<CodeSpec, "kind" | "group" | "pseudo" | "fontSize"> & { group?: string }): CodeSpec => ({
  kind: "code",
  group: "lang",
  pseudo: true,
  fontSize: 32,
  ...spec,
});

const B1 = "const bucket = Bucket()";
const B2 = "const bucket = Bucket({ versioning: true })";
const BQ = `${B2}
const queue = Queue()`;
const EMPTY_FN = `${BQ}

function api(req) {
}`;
const GET_FN = `${BQ}

function api(req) {
  const file = bucket.get(req.key)
}`;

const program = (): StepSpec[] => [
  lang({
    title: "I wanted one language where a variable can be a cloud resource",
    src: { code: B1 },
    diagram: { nodes: [at(C.bucket, 360, 150)], edges: [] },
    notes:
      "Imagine a programming language for the cloud. Declaring a bucket doesn't allocate memory: it creates a real bucket in the cloud.",
  }),
  lang({
    title: "Change its configuration, and the cloud is updated to match",
    src: { code: B2 },
    diagram: { nodes: [at(C.bucket, 360, 150, ["versioning: on"])], edges: [] },
    notes:
      "Resources have configuration that changes over time. Turn on versioning in the code, and the language reconciles the real bucket to match.",
  }),
  lang({
    title: "Declare a queue the same way",
    src: { code: BQ },
    diagram: { nodes: [at(C.bucket, 590, 100, ["versioning: on"]), at(C.queue, 590, 440)], edges: [] },
    notes: "A queue is declared just like the bucket: one line, one real queue in the cloud.",
  }),
  lang({
    title: "Unlike variables, resources outlive the program",
    src: { code: BQ },
    diagram: {
      nodes: [at(C.bucket, 590, 100, ["versioning: on"]), at(C.queue, 590, 440)],
      edges: [],
      labels: [
        {
          text: "these live in the cloud\nlong after the program runs",
          x: 190,
          y: 262,
          tone: "construct",
          arrows: [
            { from: [300, 220], to: [462, 118] },
            { from: [300, 335], to: [462, 425] },
          ],
        },
      ],
    },
    notes:
      "An ordinary program runs from start to finish and its state is gone. These don't go away when the program ends: they're a persistent world, and the next run starts from it.",
  }),
  lang({
    title: "Functions are resources too",
    src: { code: EMPTY_FN },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [] },
    notes: "Declaring a function deploys it: another node in the world.",
  }),
  lang({
    title: "When the function reads the bucket, they become connected",
    src: { code: GET_FN },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [USES[0]!] },
    notes: "Call bucket.get inside the function, and the function now depends on the bucket.",
  }),
  lang({
    title: "That connection needs permission to read the bucket",
    src: { code: GET_FN },
    diagram: { nodes: GRAPH(["versioning: on"]), edges: [GET] },
    notes: "For the function to call bucket.get, it needs an IAM policy that allows s3:GetObject on this bucket.",
  }),
  lang({
    title: "…and the bucket's name, passed in as an environment variable",
    src: { code: GET_FN },
    diagram: { nodes: GRAPH(["versioning: on"], [ENV[0]!]), edges: [GET] },
    notes:
      "And it needs to know which bucket: its name is injected as an environment variable. The permission plus the configuration is what we call a binding.",
  }),
  lang({
    title: "Sending to the queue connects them the same way",
    src: { code: VERSIONED },
    diagram: { nodes: GRAPH(["versioning: on"], ENV), edges: BINDINGS },
    notes: "Same again for the queue: sqs:SendMessage, and the queue's URL in an environment variable.",
  }),
  lang({
    title: "The language works all of this out from the code",
    src: { code: VERSIONED },
    diagram: { nodes: GRAPH(["versioning: on"], ENV), edges: BINDINGS },
    notes:
      "A cloud language derives all of this by static analysis. Nobody writes policies or environment variables by hand: the program is a graph of resources, and the code is the source of truth for how they connect.",
  }),
  lang({
    title: "But what if the function creates a bucket?",
    src: { code: SCRATCH },
    diagram: {
      nodes: [...GRAPH(["versioning: on"], ENV), SCRATCH_NODE],
      edges: BINDINGS,
      labels: [{ text: "one per request?", x: 590, y: 622, tone: "bad" }],
    },
    notes:
      "So far every resource was declared at the top. What if the function itself declares one? The function runs on every request, maybe thousands of times a second. Does each request get a new bucket? Who deletes them? Who gave the function permission to create them?",
  }),
  lang({
    title: "Uh-oh. Resources need to be known ahead of time",
    src: { code: SCRATCH },
    marks: [{ kind: "strike", find: "Bucket()", tone: "bad" }],
    diagram: {
      nodes: [...GRAPH(["versioning: on"], ENV), SCRATCH_NODE],
      edges: BINDINGS,
      labels: [{ text: "one per request?", x: 590, y: 622, tone: "bad" }],
      cards: [{ text: "✗ not known until a request arrives", tone: "bad" }],
    },
    notes:
      "It doesn't make sense. Infrastructure is created once, ahead of time, by the deploy. The function only uses it. So there are really two different kinds of code in this program.",
  }),
  lang({
    title: "So a cloud program is actually two phases",
    src: { code: VERSIONED },
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      frame: { label: "construction", tone: "construct" },
      incoming: { to: "api", label: "runtime · each request", tone: "runtime" },
    },
    notes:
      "Construction is declarative: it runs once, at deploy time, and builds the architecture: the resources and bindings. Runtime is imperative: the function body runs on every request, using what construction declared.",
  }),
  lang({
    title: "One for construction, containing the resource declarations",
    src: { code: CONSTRUCT_ONLY },
    tints: [{ from: "const bucket", to: "const queue", tone: "construct" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      frame: { label: "construction", tone: "construct" },
    },
    notes:
      "In a real language we'd make the phases explicit. First, construction: a construct function runs once, at deploy time, and everything it declares becomes infrastructure.",
  }),
  lang({
    title: "One for runtime, where those resources implement the API",
    src: { code: COLORED_APP },
    tints: [{ from: "const file", to: "queue.send(file)", tone: "runtime" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      frame: { label: "construction", tone: "construct" },
      incoming: { to: "api", label: "runtime · each request", tone: "runtime" },
    },
    notes:
      "Then runtime: a runtime function inside it runs on every request, using the resources construction declared. These are colored functions: construct and runtime are different colors, and the compiler knows which is which.",
  }),
  lang({
    title: "Now creating a bucket at runtime is a compile error",
    src: { code: COLORED_BAD },
    marks: [{ kind: "strike", find: "Bucket()", tone: "bad" }],
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      cards: [{ text: "✗ can't create a resource at runtime", tone: "bad" }],
    },
    notes: "The colors are boundaries the compiler enforces. The mistake from before, creating a bucket inside a request, is now a compile error instead of a question.",
  }),
  lang({
    title: "And inferring permissions becomes a kind of type checking",
    src: { code: COLORED_APP },
    quiet: true,
    diagram: {
      nodes: GRAPH(["versioning: on"], ENV),
      edges: BINDINGS,
      labels: [{ text: "for every possible req…", x: 360, y: 530, tone: "runtime" }],
    },
    notes:
      "Inferring the bindings is like type checking: analyze what the runtime function can do over every input it accepts, the same way a compiler infers a return type.",
  }),
];

const PUNCHCARD = `const topic = new SNS.Topic(stack, 'Topic', {
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
});`;

/** Functionless, simplified: no dependency list, the body is read instead. */
const FUNCTIONLESS = `const table = new Table(stack, "Todos");

new Function(stack, "Delete", async (id: string) => {
  await table.delete({ id });
});`;

/** A Function built around a callback it can't see inside, typed as `type`. */
const deleter = (type: string) => `function deleter(remove: (id: string) => ${type}) {
  return new Function(stack, "Delete", async (id: string) => {
    await remove(id);
  });
}`;

/** The Worker's requirements, listed beside its code. */
const REQ_LABEL = "Req · what it needs";
const BUCKET: ReqItem = { name: "R2.BucketProvider", note: "to create the bucket" };
const READ: ReqItem = { name: "R2.ReadBucket", note: "to read it at runtime" };
const QUEUE: ReqItem = { name: "Queues.QueueProvider", note: "to create the queue" };
const WRITE_LOGS: ReqItem = { name: "R2.WriteBucket", note: "only in dev" };
const WRITE: ReqItem = { name: "Queues.WriteQueue", note: "to send at runtime" };
const met = (item: ReqItem, note: string): ReqItem => ({ ...item, state: "met", note });
const WORKER: ReqItem = { name: "Cloudflare.Worker", note: "native bindings run inside a Worker" };
const PHANTOM: ReqItem = { name: "RuntimeContext", state: "met", note: "RuntimeContext.phantom\nopted out, in plain sight" };
/** Everything the Worker version of the program needs, with the bindings provided. */
const PROVIDED: ReqItem[] = [
  met(READ, "ReadBucketBinding\nadds a native R2 binding"),
  met(WRITE, "WriteQueueBinding\nadds a native Queue binding"),
  met(WORKER, "it runs in a Worker"),
];

/** The Worker with a hypothetical catch-all layer: not a real API. */
const ALL_BINDINGS = `export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* R2.Bucket("Uploads");
    const uploads = yield* R2.ReadBucket(bucket);
    const queue = yield* Queues.Queue("Jobs");
    const jobs = yield* Queues.WriteQueue(queue);
    return {
      fetch: Effect.gen(function* () {
        const file = yield* uploads.get("hello.txt");
        yield* jobs.send({ size: file?.size });
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide([
      R2.AllBindings,
      Queues.AllBindings,
    ]),
  ),
);`;

/** The first line of the compiler's message that starts with `prefix`. */
const firstLine = (prefix: string) => (lines: string[]) => lines.filter((line) => line.startsWith(prefix)).slice(0, 1);

/** One version of the Api Worker, `snippets/api-*.ts`, with its Req beside it. */
const api = (s: {
  title: string;
  /** A type-checked `snippets/api-*.ts`, or inline code for an idea that was never shipped. */
  snippet?: string;
  code?: string;
  notes: string;
  req: ReqItem[];
  /** Req of the runtime function, when it has its own. */
  fetchReq?: ReqItem[];
  tints?: CodeSpec["tints"];
  marks?: CodeSpec["marks"];
  error?: CodeSpec["error"];
  quiet?: boolean;
  aside?: CodeSpec["aside"];
}): CodeSpec => ({
  kind: "code",
  group: "api",
  file: "src/Api.ts",
  title: s.title,
  src: s.snippet ? { snippet: s.snippet, regions: ["show"] } : { code: s.code! },
  tints: s.tints,
  marks: s.marks,
  error: s.error,
  quiet: s.quiet,
  aside: s.aside,
  req: {
    label: REQ_LABEL,
    items: s.req,
    parts: s.fetchReq ? [{ label: "fetch's Req", items: s.fetchReq }] : undefined,
  },
  notes: s.notes,
});

// My first attempt: infer the binding from how the bucket is used, the way
// the imaginary language did. Never shipped, so it isn't type-checked.
const INFERRED = `const api = Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  return {
    fetch: Effect.gen(function* () {
      const file = yield* bucket.get("hello.txt");
      return HttpServerResponse.text("ok");
    }),
  };
});`;
const INFERRED_ON_FETCH = `const api = Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  return {
    fetch: Effect.gen(function* () {
      const file = yield* bucket.get("hello.txt");
      return HttpServerResponse.text("ok");
    }).pipe(Effect.provide(R2.ReadBucket(bucket))),
  };
});`;
const INFERRED_HOISTED = `const Uploads = R2.Bucket("Uploads");

const api = Effect.gen(function* () {
  const bucket = yield* Uploads;
  return {
    fetch: Effect.gen(function* () {
      const file = yield* bucket.get("hello.txt");
      return HttpServerResponse.text("ok");
    }),
  };
}).pipe(Effect.provide(R2.ReadBucket(Uploads)));`;
const INFERRED_DEV = `const Uploads = R2.Bucket("Uploads");
const Logs = R2.Bucket("Logs");

const api = Effect.gen(function* () {
  const bucket = yield* Uploads;
  const logs = dev ? yield* Logs : undefined;
  return {
    fetch: Effect.gen(function* () {
      const file = yield* bucket.get("hello.txt");
      if (logs) yield* logs.put("last-read", file);
      return HttpServerResponse.text("ok");
    }),
  };
}).pipe(Effect.provide([R2.ReadBucket(Uploads), R2.WriteBucket(Logs)]));`;
const HOIST_TYPE = `type Hoisted<A> =
  A extends { fetch: Effect<any, any, infer R> } ? R : never;`;
const INFERRED_DEV_2 = INFERRED_DEV.replace(
  "Effect.provide([R2.ReadBucket(Uploads), R2.WriteBucket(Logs)])",
  "Effect.provide(R2.ReadBucket(Uploads))",
);
const PUT_LOGS: ReqItem = { name: "R2.PutObject<Logs>", note: "hoisted out of fetch's type" };
const GET_OBJECT: ReqItem = { name: "R2.GetObject<Uploads>", note: "inferred from bucket.get" };
const GET_OBJECT_HOISTED = met(
  { name: "R2.GetObject<Uploads>" },
  "R2.ReadBucket(Uploads)\nhoisted out of fetch's type",
);

// The last problem: a service's interface can't hide which implementation it has.
const SERVICE = `class Storage extends Context.Service<Storage, {
  get(key: string): Effect<File, NotFound>;
}>()("Storage") {}`;
const SERVICE_R2 = SERVICE.replace("Effect<File, NotFound>", "Effect<File, NotFound, R2.GetObject<Uploads>>");
const STORAGE_R2 = `const StorageR2 = Layer.effect(Storage, Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  return { get: (key) => bucket.get(key) };
}));`;
const STORAGE_S3 = `const StorageS3 = Layer.effect(Storage, Effect.gen(function* () {
  const bucket = yield* S3.Bucket("Files");
  return { get: (key) => bucket.get(key) };
}));`;

// ── Act 0: infrastructure as code, and why combine it with runtime code ──
const CFN = `Conditions:
  IsProd: !Equals [!Ref Stage, prod]
Resources:
  Uploads:
    Type: AWS::S3::Bucket
  ApiRole:
    Type: AWS::IAM::Role
    Properties:
      Policies:
        - PolicyName: uploads
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action: [s3:GetObject, s3:PutObject]
                Resource: !Sub "\${Uploads.Arn}/*"
  Api:
    Type: AWS::Lambda::Function
    Properties:
      Handler: index.handler
      Role: !GetAtt ApiRole.Arn
      MemorySize: !If [IsProd, 1024, 256]
      Environment:
        Variables:
          BUCKET_NAME: !Ref Uploads`;
const CDK = `class Api extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const uploads = new s3.Bucket(this, "Uploads");
    const fn = new lambda.Function(this, "Fn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("dist"),
      environment: {
        BUCKET_NAME: uploads.bucketName,
      },
    });
    uploads.grantReadWrite(fn);
  }
}`;
const HANDLER = `const s3 = new S3Client({});

export const handler = async (event) => {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: event.key,
    Body: event.body,
  }));
};`;
const CDK_LINKS: NonNullable<CodeSpec["links"]> = [
  { from: '"index.handler"', to: "export const handler" },
  { from: "BUCKET_NAME", to: "process.env.BUCKET_NAME" },
  { from: "grantReadWrite", to: "PutObjectCommand" },
];

// ── terminal output, in the CLI's own colors ─────────────────────────────
const T = { ok: "\x1b[38;5;113m", soft: "\x1b[38;5;150m", accent: "\x1b[38;5;173m", grey: "\x1b[38;5;102m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };
const RULE = `${T.grey}${T.dim}${"─".repeat(46)}${T.reset}`;
const DEPLOY_PLAN = [
  `${T.dim}$${T.reset} alchemy deploy`,
  `${T.ok}✓${T.reset} Plan ready ${T.dim}(0.8s)${T.reset}`,
  RULE,
  `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}3 to create${T.reset}${T.dim} · ${T.reset}${T.soft}2 bindings${T.reset}`,
  ``,
  `${T.ok}+${T.reset} ${T.ok}${T.bold}Uploads${T.reset} ${T.dim}(Cloudflare.R2.Bucket)${T.reset}`,
  `${T.ok}+${T.reset} ${T.ok}${T.bold}Jobs${T.reset} ${T.dim}(Cloudflare.Queues.Queue)${T.reset}`,
  `${T.ok}+${T.reset} ${T.ok}${T.bold}Api${T.reset} ${T.dim}(Cloudflare.Worker)${T.reset}`,
  `  ${T.ok}+${T.reset} ${T.soft}Uploads${T.reset}`,
  `  ${T.ok}+${T.reset} ${T.soft}Jobs${T.reset}`,
  RULE,
  `${T.bold}Deploy?${T.reset}  ${T.accent}${T.bold}› Deploy${T.reset}  ${T.dim}Cancel${T.reset}`,
].join("\n");
const DEPLOY_APPLIED = [
  `${T.dim}$${T.reset} alchemy deploy`,
  `${T.ok}✓${T.reset} Plan ready ${T.dim}(0.8s)${T.reset}`,
  RULE,
  `${T.accent}${T.bold}Plan${T.reset}${T.dim} · ${T.reset}${T.ok}3 created${T.reset}`,
  ``,
  `${T.ok}✓${T.reset} ${T.bold}Uploads${T.reset} ${T.dim}(Cloudflare.R2.Bucket)${T.reset} created ${T.dim}(1.2s)${T.reset}`,
  `${T.ok}✓${T.reset} ${T.bold}Jobs${T.reset} ${T.dim}(Cloudflare.Queues.Queue)${T.reset} created ${T.dim}(1.9s)${T.reset}`,
  `${T.ok}✓${T.reset} ${T.bold}Api${T.reset} ${T.dim}(Cloudflare.Worker)${T.reset} created ${T.dim}(6.4s)${T.reset}`,
  `  ${T.ok}✓${T.reset} ${T.soft}Uploads${T.reset} created`,
  `  ${T.ok}✓${T.reset} ${T.soft}Jobs${T.reset} created`,
  RULE,
  `${T.ok}Stack deployed (3/3)${T.reset} ${T.dim}{ url: "https://api.workers.dev" }${T.reset}`,
].join("\n");

// The Stack, built up one piece at a time; the last version is snippets/stack.ts.
const STACK_1 = `export default Alchemy.Stack(
  "App",
);`;
const STACK_2 = `export default Alchemy.Stack(
  "App",
  {
    providers: Cloudflare.providers(),
  },
);`;
const STACK_3 = `export default Alchemy.Stack(
  "App",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
);`;
const STACK_4 = `export default Alchemy.Stack(
  "App",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
  }),
);`;
/** One step of building the Stack in alchemy.run.ts. */
const stack = (s: {
  title: string;
  code: string;
  notes: string;
  marks?: CodeSpec["marks"];
  panel?: CodeSpec["panel"];
  req?: ReqItem[];
}): CodeSpec => ({
  kind: "code",
  group: "stack",
  file: "alchemy.run.ts",
  title: s.title,
  src: { code: s.code },
  marks: s.marks,
  panel: s.panel,
  req: s.req ? { label: REQ_LABEL, items: s.req } : undefined,
  notes: s.notes,
});

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

  // Act 0: why combine infrastructure and runtime code at all
  {
    kind: "code",
    group: "cfn",
    file: "template.yaml",
    lang: "yaml",
    title: "I started out writing CloudFormation",
    src: { code: CFN },
    notes:
      "Some context first. I started out writing infrastructure as CloudFormation: a bucket, a role, a Lambda function, all in YAML.",
  },
  {
    kind: "code",
    group: "cfn",
    file: "template.yaml",
    lang: "yaml",
    title: "…and I hated trying to program in YAML",
    src: { code: CFN },
    marks: [
      { kind: "circle", find: "!If [IsProd, 1024, 256]", label: "an if statement, in YAML", side: "right", tone: "bad" },
      { kind: "underline", find: '!Sub "${Uploads.Arn}/*"', label: "string templating for references", side: "right", tone: "bad" },
    ],
    notes:
      "And I hated it. I'm a coder. I don't want to write config files, and I really don't want to program in YAML: conditions, string substitution, intrinsic functions.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "Then the AWS CDK came out, and I was hooked",
    src: { code: CDK },
    notes: "Then the AWS CDK came out and I was instantly hooked. The same infrastructure, as a TypeScript class.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "Finally, I could configure infrastructure with real code",
    src: { code: CDK },
    marks: [{ kind: "underline", find: "uploads.grantReadWrite(fn);", label: "the whole IAM policy", side: "right", tone: "good" }],
    notes:
      "Finally, real code: variables, functions, types, and abstractions like grantReadWrite that write the IAM policy for you.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "But the runtime code still lived in a separate program",
    src: { code: CDK },
    beside: { file: "src/handler.ts", src: { code: HANDLER } },
    notes:
      "But the CDK is still only infrastructure. The code that actually runs in the Lambda is a separate program, in a separate file, bundled and deployed separately.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "I was always juggling two programs that are really one",
    src: { code: CDK },
    beside: { file: "src/handler.ts", src: { code: HANDLER } },
    links: CDK_LINKS,
    frames: 45,
    notes:
      "And the two are coupled. The handler name has to match an export. The environment variable has to match what the handler reads. The grant has to cover every call the handler makes. Every change means juggling two programs that are really one.",
  },
  {
    kind: "code",
    group: "cdk",
    file: "infra/api.ts",
    title: "Rename one side, and nothing tells you the other broke",
    src: { code: CDK.replace("BUCKET_NAME", "UPLOADS_BUCKET") },
    beside: {
      file: "src/handler.ts",
      src: { code: HANDLER },
      marks: [{ kind: "circle", find: "BUCKET_NAME", label: "undefined!", side: "right", tone: "bad" }],
    },
    links: [
      { from: '"index.handler"', to: "export const handler" },
      { from: "UPLOADS_BUCKET", to: "process.env.BUCKET_NAME", tone: "bad" },
      { from: "grantReadWrite", to: "PutObjectCommand" },
    ],
    notes:
      "Rename the environment variable in the infrastructure, and the handler still compiles, still deploys, and then fails at runtime. Neither program knows about the other. That's what made me want one program, and one language, for both.",
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
    title: "First came Punchcard, which added runtime code to the AWS CDK",
    src: { code: PUNCHCARD },
    tints: [{ from: "async (event", to: "}));", tone: "runtime" }],
    notes:
      "In 2018 and 2019 I built Punchcard on top of the AWS CDK. It modeled the two phases: declare a topic, depend on it from a Function, and get a typed client at runtime with the IAM policy generated for you.",
  },
  {
    kind: "code",
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "But its runtime code shipped with the whole CDK",
    src: { code: PUNCHCARD },
    tints: [{ from: "async (event", to: "}));", tone: "runtime" }],
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
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "And every dependency had to be declared up front",
    src: { code: PUNCHCARD },
    marks: [
      { kind: "circle", find: "depends: topic", label: "declared up front…", side: "right", tone: "construct" },
      { kind: "underline", find: "(event, topic)", label: "…then passed down to where it's used", side: "right", tone: "construct" },
    ],
    notes:
      "And every dependency had to be listed up front, in depends, and then prop-drilled into the handler as an argument. The code that uses the topic can't just reach for it.",
  },
  {
    kind: "code",
    group: "punchcard",
    file: "punchcard · stack.ts",
    title: "…and carried through every function on the way down",
    src: { code: PUNCHCARD },
    marks: [
      { kind: "circle", find: "depends: topic", label: "declared up front…", side: "right", tone: "construct" },
      { kind: "underline", find: "(event, topic)", label: "…then passed down to where it's used", side: "right", tone: "construct" },
    ],
    drill: {
      label: "in a real app",
      name: "topic",
      lines: [
        "handler(event, topic)",
        "  placeOrder(order, topic)",
        "    chargeCard(order, topic)",
        "      sendReceipt(order, topic)",
        "        topic.publish(receipt)",
      ],
      note: "carried by every layer, used by one",
    },
    frames: 45,
    notes:
      "That's prop drilling. The handler rarely publishes directly: it calls placeOrder, which calls chargeCard, which calls sendReceipt, and only that last one publishes. Every function in between has to take the topic as a parameter just to hand it down. Add a second resource and you touch every signature again.",
  },
  {
    kind: "code",
    group: "functionless",
    file: "functionless · app.ts",
    title: "Then came Functionless, which used compiler tricks instead",
    src: { code: FUNCTIONLESS },
    notes:
      "So in 2022 the next attempt, Functionless, dropped the declarations. Just use the table inside the function, and let static analysis work out what it touches.",
  },
  {
    kind: "code",
    group: "functionless",
    file: "functionless · app.ts",
    title: "It peeks inside to see which resources the function uses",
    src: { code: FUNCTIONLESS },
    marks: [{ kind: "circle", find: "table.delete", label: "found by reading the body", side: "right", tone: "construct" }],
    panel: {
      title: "Inferred",
      items: [{ title: "IAM policy", mono: `Allow dynamodb:DeleteItem\non table Todos` }],
    },
    notes:
      "It walks the function's syntax tree, follows variables into the scope they came from, sees table.delete, and infers the DynamoDB permission. That looks like it works.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "But it can't see inside a function that's passed in",
    src: { code: deleter("Promise<void>") },
    marks: [{ kind: "circle", find: "remove(id)", label: "which function? could be anything", side: "right", tone: "bad" }],
    notes:
      "But peeking inside breaks down fast. Take a function that's passed in. Which function is remove? It depends on the caller, so reading this body tells you nothing.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "Unless its type says what it needs",
    src: { code: deleter("Promise<void, DeleteItem>") },
    notes:
      "But what if the type of remove told us? Imagine a type parameter that lists what the function needs from the outside world: here, permission to delete an item.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "Then inferring permissions is just type checking",
    src: { code: deleter("Promise<void, DeleteItem>") },
    marks: [
      { kind: "circle", find: "DeleteItem", tone: "construct" },
      { kind: "underline", find: "new Function", label: "so it needs DeleteItem too", side: "right", tone: "construct" },
    ],
    notes:
      "Now nobody has to read the body. A type checker never looks inside the functions you call; it reads their signatures. The Function calls remove, so it needs DeleteItem too, and that's the policy. Higher-order functions and classes just work.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "It could say how it fails, too",
    src: { code: deleter("Promise<void, NotFound, DeleteItem>") },
    notes: "And while we're at it, the type could say how the function fails, too.",
  },
  {
    kind: "code",
    group: "hidden",
    file: "functionless · app.ts",
    title: "Wait… this looks familiar",
    src: { code: deleter("Effect<void, NotFound, DeleteItem>") },
    notes: "Wait. A value, an error, and its requirements. We've seen this before.",
  },

  // Act 4: Effect is the missing piece
  {
    kind: "code",
    group: "effect",
    title: "That's exactly the type of an Effect",
    src: { code: "Effect<A, Err, Req>" },
    fontSize: 96,
    marks: [
      { kind: "underline", find: "A", label: "what it returns", side: "above", tone: "neutral" },
      { kind: "underline", find: "Err", label: "how it fails", side: "below", tone: "neutral" },
      { kind: "circle", find: "Req", label: "what it needs", side: "above", tone: "construct" },
    ],
    notes: "That's Effect. Success, errors, and the requirements channel: the signature we were missing.",
  },

  // Act 5: the same program, in Alchemy. The code grows one idea at a time;
  // beside it, the Worker's Req: what it still needs from the outside world.
  api({
    title: "Let's write the program again with Effect",
    snippet: "api-01-effect.ts",
    req: [],
    notes:
      "Start with just the function. Effect.gen describes a program without running it, and this one returns a fetch handler, which is itself an Effect. On the right is its Req, what it needs from the outside world. Right now: nothing.",
  }),
  api({
    title: "The outer Effect is the construction phase",
    snippet: "api-01-effect.ts",
    tints: [{ from: "const api = Effect.gen", to: "return {", tone: "construct" }],
    req: [],
    notes: "The outer Effect runs once, when the function is set up: that's the construction phase.",
  }),
  api({
    title: "…and fetch is the runtime phase",
    snippet: "api-01-effect.ts",
    tints: [{ from: "fetch: Effect.gen", to: "}),", tone: "runtime" }],
    req: [],
    notes: "And fetch runs for each request: the runtime phase. The same two phases as our imaginary language, written with plain TypeScript and Effect.",
  }),
  api({
    title: "Declare a bucket in construction, with yield*",
    snippet: "api-02-bucket.ts",
    req: [],
    notes:
      "Declare a bucket in the construction phase with yield*. Creating it is the deploy's job, which we'll come back to with the Stack. For now, Req stays empty.",
  }),
  api({
    title: "My first try inferred the binding from how it's used",
    code: INFERRED,
    req: [],
    fetchReq: [GET_OBJECT],
    notes:
      "My first attempt looked exactly like the imaginary language. Just call bucket.get, and the type of that call carries the requirement: R2.GetObject for the Uploads bucket. No declaration needed.",
  }),
  api({
    title: "But then the layer goes on fetch, which runs at runtime",
    code: INFERRED_ON_FETCH,
    req: [],
    fetchReq: [{ ...GET_OBJECT, state: "bad", note: "provided per request:\ntoo late to grant a policy" }],
    notes:
      "The requirement lands on fetch, so that's where its layer has to be provided. But fetch runs at runtime, on every request. The layer is what grants the policy, and by then the deploy is long over. This makes no sense.",
  }),
  api({
    title: "Moving the bucket out puts the layer on construction",
    code: INFERRED_HOISTED,
    req: [GET_OBJECT_HOISTED],
    notes:
      "Where we actually want it is on the outer Effect, the construction phase. So the bucket moves out to module scope, where the layer can name it, and Effect.provide(R2.ReadBucket(Uploads)) goes on the outer Effect.",
  }),
  api({
    title: "But it's only found by digging into fetch's type",
    code: `${INFERRED_HOISTED}\n\n${HOIST_TYPE}`,
    marks: [{ kind: "circle", find: "infer R", label: "type magic on what it returns", side: "right", tone: "bad" }],
    req: [GET_OBJECT_HOISTED],
    notes:
      "But the outer Effect doesn't need R2.GetObject. Only fetch does. The only way construction learns about it is type magic: dig into the return type of the Effect, find fetch, infer its requirements, and hoist them up. The requirement is discovered by analyzing the runtime function, not declared.",
  }),
  api({
    title: "This is starting to feel like peeking inside again…",
    code: `${INFERRED_HOISTED}\n\n${HOIST_TYPE}`,
    marks: [{ kind: "circle", find: "infer R", label: "type magic on what it returns", side: "right", tone: "bad" }],
    req: [GET_OBJECT_HOISTED],
    notes:
      "Hang on. Reaching into fetch to find out what it uses… that's Functionless all over again. Peeking inside, just with types instead of the compiler. Let's keep going anyway and see where it breaks.",
  }),
  api({
    title: "…which becomes really clear when your infrastructure is conditional",
    code: INFERRED_DEV_2,
    req: [GET_OBJECT_HOISTED, PUT_LOGS],
    notes:
      "And that becomes really clear the moment your infrastructure is conditional. Say we only want a Logs bucket in dev, and fetch writes the last read to it when it's there. That write shows up in fetch's type as R2.PutObject for Logs, and the type magic hoists it up.",
  }),
  api({
    title: "But we can't tell that logs.put is only required during dev",
    code: INFERRED_DEV_2,
    marks: [{ kind: "underline", find: "if (logs)", label: "only in dev", side: "right", tone: "bad" }],
    req: [GET_OBJECT_HOISTED, { ...PUT_LOGS, state: "bad", note: "required in every stage" }],
    notes:
      "But the if only runs in dev, and a type can't know that. fetch's type is the union of every path through it, so R2.PutObject for Logs is required everywhere, production included. Types see every possible path, never the one that actually runs.",
  }),
  api({
    title: "Now the Layer has to cover every path the code might take",
    code: INFERRED_DEV,
    req: [
      GET_OBJECT_HOISTED,
      { name: "R2.PutObject<Logs>", state: "bad", note: "R2.WriteBucket(Logs)\nprovided in production too" },
    ],
    notes:
      "So to compile, we provide R2.WriteBucket for Logs, in every stage. And the layers are what carry the policies, so every policy for every path gets granted, whether that path runs or not.",
  }),
  api({
    title: "…even the ones it never takes",
    code: INFERRED_DEV,
    marks: [
      {
        kind: "underline",
        find: "R2.WriteBucket(Logs)",
        label: "prod gets a permission only dev needs:\nleast privilege, violated",
        side: "below",
        arrow: true,
        tone: "bad",
      },
    ],
    req: [
      GET_OBJECT_HOISTED,
      { name: "R2.PutObject<Logs>", state: "bad", note: "R2.WriteBucket(Logs)\nprovided in production too" },
    ],
    notes:
      "Even if production never takes that path. The dev-only write to Logs is still in the type, so the WriteBucket layer has to be provided everywhere, and production gets permission to write to a bucket only dev uses. That's a least-privilege violation, baked in by the type system.",
  }),
  api({
    title: "What we learned is that we've broken encapsulation",
    code: INFERRED_DEV,
    marks: [{ kind: "underline", find: "fetch: Effect.gen(function* () {", label: "its type now says R2, and which buckets", side: "right", tone: "bad" }],
    req: [
      GET_OBJECT_HOISTED,
      { name: "R2.PutObject<Logs>", state: "bad", note: "R2.WriteBucket(Logs)\nprovided in production too" },
    ],
    notes:
      "Step back and look at what happened. The infrastructure a function uses has become part of its type. fetch's type now says R2, and exactly which buckets. That's broken encapsulation, and it's the problem that finally killed this design.",
  }),
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "To illustrate this, let's try to implement an Effect service",
    src: { code: SERVICE },
    notes:
      "To illustrate this, let's try to implement an Effect service, Effect's tool for encapsulation. An interface, with implementations provided as Layers. Storage gets a file by key, and says nothing about where files live. That's the whole point.",
  },
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "Implementing it with R2 needs R2.GetObject<Uploads>",
    src: { code: `${SERVICE}\n\n${STORAGE_R2}` },
    marks: [{ kind: "underline", find: "bucket.get(key)", label: "requires R2.GetObject<Uploads>", side: "right", tone: "bad" }],
    notes:
      "Now implement it with R2. Because the requirement is inferred from usage, this get doesn't just return a file: its type also requires R2.GetObject for the Uploads bucket. And that doesn't match the interface, which requires nothing.",
  },
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "The only fix is to name R2, and the bucket, in the interface",
    src: { code: `${SERVICE_R2}\n\n${STORAGE_R2}` },
    marks: [{ kind: "circle", find: "R2.GetObject<Uploads>", label: "the implementation, in the interface", side: "below", tone: "bad" }],
    notes:
      "The only way to make it fit is to put the requirement in the interface. Now Storage says R2, and which bucket. The implementation has leaked into the interface.",
  },
  {
    kind: "code",
    group: "service",
    file: "src/Storage.ts",
    title: "Now there can never be a second implementation",
    src: { code: `${SERVICE_R2}\n\n${STORAGE_R2}\n\n${STORAGE_S3}` },
    marks: [
      { kind: "circle", find: "R2.GetObject<Uploads>", label: "the implementation, in the interface", side: "below", tone: "bad" },
      { kind: "underline", find: { text: "bucket.get(key)", nth: 2 }, label: "requires S3.GetObject<Files>: doesn't fit", side: "right", tone: "bad" },
    ],
    notes:
      "And that's the nail in the coffin. Try an S3 implementation: same code, but its get requires S3.GetObject, and the interface already promised R2. You can't swap implementations, which is the whole point of a service. Infrastructure requirements can't live in the runtime function's type.",
  },
  api({
    title: "So what I actually ended up realizing…",
    snippet: "api-02-bucket.ts",
    req: [],
    notes:
      "So let's go back to where we branched off: a bucket, declared in construction. What I actually ended up realizing is that I'd been trying to be too clever.",
  }),
  api({
    title: "…is that a binding should be declared, just like a resource",
    snippet: "api-04-get.ts",
    req: [{ ...READ, note: "declared in construction" }],
    notes:
      "It's still infrastructure as code, and I should embrace that. You declare a resource with yield*, so declare the binding the same way: R2.ReadBucket(bucket). The requirement lands on the program, where a Layer can satisfy it, and fetch just calls the client it got back. Its type stays clean, so a service built on it can have any implementation.",
  }),
  api({
    title: "Conditional infrastructure is then just an if statement",
    snippet: "api-04b-dev.ts",
    req: [{ ...READ, note: "declared in construction" }, WRITE_LOGS],
    notes:
      "And conditional infrastructure is just ordinary code. Only in dev do we create a Logs bucket and bind it for writing. No new syntax, no analysis: an if statement, or here a ternary.",
  }),
  api({
    title: "Running the code discovers the bindings, not analyzing it",
    snippet: "api-04b-dev.ts",
    marks: [{ kind: "underline", find: "R2.WriteBucket(logs)", label: "skipped in prod", side: "right", tone: "good" }],
    req: [{ ...READ, note: "declared in construction" }, { ...WRITE_LOGS, note: "only bound when\nthis line runs" }],
    notes:
      "Here's the key. Alchemy doesn't read your code to find the bindings. It runs it. In dev the WriteBucket line runs, and the binding and its policy are attached. In production it's skipped, so production never gets that permission. Least privilege, for free. The types still say which implementations must be available; running the code decides what's actually granted.",
  }),
  api({
    title: "That's why construction runs at deploy time…",
    snippet: "api-04b-dev.ts",
    tints: [{ from: "const api = Effect.gen", to: "const writeLogs", tone: "construct" }],
    marks: [{ kind: "circle", find: "R2.ReadBucket(bucket)", label: "attach binding + policy", side: "right", tone: "construct" }],
    req: [{ ...READ, note: "declared in construction" }, { ...WRITE_LOGS, note: "only bound when\nthis line runs" }],
    notes:
      "Which is why Alchemy is two-phase. The construction phase runs at deploy time: running it is how Alchemy discovers every resource and binding, and attaches the policies.",
  }),
  api({
    title: "…and again at cold start, to create the clients",
    snippet: "api-04b-dev.ts",
    tints: [{ from: "const api = Effect.gen", to: "const writeLogs", tone: "runtime" }],
    marks: [{ kind: "circle", find: "R2.ReadBucket(bucket)", label: "return an R2 client", side: "right", tone: "runtime" }],
    req: [{ ...READ, note: "declared in construction" }, { ...WRITE_LOGS, note: "only bound when\nthis line runs" }],
    notes:
      "And it runs again inside the deployed function, at cold start. The same line now returns a real client. The same code does both jobs, so the infrastructure and the runtime can never disagree, which is exactly the problem I had with the CDK and a separate handler.",
  }),
  api({
    title: "…while fetch runs on every request",
    snippet: "api-04b-dev.ts",
    tints: [{ from: "fetch: Effect.gen", to: "})", tone: "runtime" }],
    req: [{ ...READ, note: "declared in construction" }, { ...WRITE_LOGS, note: "only bound when\nthis line runs" }],
    notes: "And fetch is the runtime phase. It runs for every request, using the clients that construction handed it.",
  }),
  api({
    title: "Sending to a queue works the same way",
    snippet: "api-05-queue.ts",
    req: [READ, WRITE],
    notes: "A queue is the same: declare it, ask to write to it, and Req gains Queues.WriteQueue.",
  }),
  api({
    title: "Then we hand it a Layer for each binding it needs",
    snippet: "api-06-provide.ts",
    req: [met(READ, "ReadBucketBinding"), met(WRITE, "WriteQueueBinding"), WORKER],
    notes:
      "Effect.provide satisfies each one with a Layer: an implementation of the requirement. These use Cloudflare's native bindings, and that adds a requirement of its own: they only work inside a Cloudflare Worker.",
  }),
  api({
    title: "But they don't grant the policy, they define how it's made",
    snippet: "api-06-provide.ts",
    marks: [
      {
        kind: "box",
        find: "R2.ReadBucketBinding,",
        to: "Queues.WriteQueueBinding,",
        label: "binding layers",
        side: "right",
        tone: "construct",
      },
    ],
    req: [met(READ, "ReadBucketBinding"), met(WRITE, "WriteQueueBinding"), WORKER],
    notes:
      "But careful: these layers aren't the policy. They define how the policy gets made. They're binding layers, and a binding layer has two faces.",
  }),
  api({
    title: "Its first face runs at construction and wires up the binding",
    snippet: "api-06-provide.ts",
    tints: [{ from: "const api = Effect.gen", to: "const jobs", tone: "construct" }],
    marks: [{ kind: "circle", find: "R2.ReadBucket(bucket)", label: "binding, policy, env vars", side: "right", tone: "construct" }],
    req: [
      met(READ, "ReadBucketBinding\nattaches the R2 binding"),
      met(WRITE, "WriteQueueBinding\nattaches the Queue binding"),
      WORKER,
    ],
    notes:
      "The first face runs during construction. When R2.ReadBucket(bucket) runs at deploy time, ReadBucketBinding wires up the binding: the native R2 binding on the Worker, plus whatever policy and environment variables it needs. Only for what the code actually declared.",
  }),
  api({
    title: "Its second face runs at runtime and implements the interface",
    snippet: "api-06-provide.ts",
    tints: [{ from: "fetch: Effect.gen", to: "}),", tone: "runtime" }],
    marks: [{ kind: "underline", find: 'uploads.get("hello.txt")', label: "the layer's get", side: "right", tone: "runtime" }],
    req: [
      met(READ, "ReadBucketBinding\nimplements get"),
      met(WRITE, "WriteQueueBinding\nimplements send"),
      WORKER,
    ],
    notes:
      "The second face is what R2.ReadBucket(bucket) returns: code that runs at runtime and implements the interface. When fetch calls uploads.get, that's the layer's get, talking to the native R2 binding.",
  }),
  api({
    title: "Bring back the dev-only Logs bucket, and provide its layer",
    snippet: "api-06b-dev.ts",
    req: [
      met(READ, "ReadBucketBinding"),
      met(WRITE, "WriteQueueBinding"),
      met(WRITE_LOGS, "WriteBucketBinding"),
      WORKER,
    ],
    notes:
      "Remember the Logs bucket that only exists in dev? The program uses R2.WriteBucket, so its layer has to be provided: R2.WriteBucketBinding goes in the array, in every stage.",
  }),
  api({
    title: "In prod that line never runs, so no policy is ever made",
    snippet: "api-06b-dev.ts",
    marks: [{ kind: "underline", find: "R2.WriteBucket(logs)", label: "skipped in prod", side: "right", tone: "good" }],
    req: [
      met(READ, "ReadBucketBinding"),
      met(WRITE, "WriteQueueBinding"),
      met(WRITE_LOGS, "WriteBucketBinding\nnever runs in prod"),
      WORKER,
    ],
    notes:
      "But the layer's construction face only runs when that line runs. In production, logs is undefined, so R2.WriteBucket(logs) never runs: no binding is attached, no policy is created, no environment variable is set.",
  }),
  api({
    title: "The layer ships in the bundle, but least privilege holds",
    snippet: "api-06b-dev.ts",
    marks: [
      { kind: "underline", find: "R2.WriteBucket(logs)", label: "skipped in prod", side: "right", tone: "good" },
      { kind: "box", find: "R2.WriteBucketBinding,", label: "in the bundle, never granted", side: "right", tone: "good" },
    ],
    req: [
      met(READ, "ReadBucketBinding"),
      met(WRITE, "WriteQueueBinding"),
      met(WRITE_LOGS, "WriteBucketBinding\nno permission in prod"),
      WORKER,
    ],
    notes:
      "So the WriteBucketBinding code is still in the production bundle, but it never grants anything there. Providing a layer isn't granting a permission; running the code is. That's the difference from my first attempt, where the type demanded the permission in every stage.",
  }),
  api({
    title: "The layer ships in the bundle, but least privilege holds",
    snippet: "api-06b-dev.ts",
    marks: [
      { kind: "underline", find: "R2.WriteBucket(logs)", label: "skipped in prod", side: "right", tone: "good" },
      { kind: "box", find: "R2.WriteBucketBinding,", label: "in the bundle, never granted", side: "right", tone: "good" },
    ],
    req: [
      met(READ, "ReadBucketBinding"),
      met(WRITE, "WriteQueueBinding"),
      met(WRITE_LOGS, "WriteBucketBinding\nno permission in prod"),
      WORKER,
    ],
    aside: { text: "usually, pragmatism beats purity", image: "michael-pointing.jpg" },
    notes:
      "A small trade-off: a few bytes of unused client code in production, in exchange for a program that stays plain code. Usually, pragmatism beats purity. Sorry, Michael.",
  }),
  api({
    title: "So far, though, it's just a program that nothing runs",
    snippet: "api-06-provide.ts",
    req: [met(READ, "ReadBucketBinding"), met(WRITE, "WriteQueueBinding"), WORKER],
    notes:
      "Let's drop the Logs bucket again to keep the code small. And notice what we have: api is just a value. An Effect describing a program. Nothing has deployed it, and nothing runs it yet.",
  }),
  api({
    title: "Now let's actually deploy it, starting with a Worker",
    snippet: "api-07-worker.ts",
    req: PROVIDED,
    notes:
      "So let's actually deploy it somewhere. Wrap it in a Cloudflare Worker: the function resource from our imaginary language. The Worker checks the program's Req against what it can provide, and it can provide itself.",
  }),
  api({
    title: "export default and import.meta.url say what to bundle",
    snippet: "api-07-worker.ts",
    marks: [
      { kind: "underline", find: "export default", label: "the Worker's entrypoint", side: "right", tone: "construct" },
      { kind: "circle", find: "import.meta.url", label: "this file", side: "right", tone: "construct" },
    ],
    req: PROVIDED,
    notes:
      "Two conventions you'll see everywhere. The Worker is the file's default export, and main is import.meta.url: this very file. That tells Alchemy what to bundle and what the entrypoint is. There's no separate handler file to keep in sync.",
  }),
  api({
    title: "Rolldown bundles it, and tree-shakes what you don't use",
    snippet: "api-07-worker.ts",
    marks: [
      {
        kind: "box",
        find: "R2.ReadBucketBinding,",
        to: "Queues.WriteQueueBinding,",
        label: "only these clients are bundled",
        side: "right",
        tone: "construct",
      },
    ],
    req: PROVIDED,
    notes:
      "At deploy time Alchemy runs the file through Rolldown and tree-shakes it hard. Anything the Worker doesn't reach is dropped. The binding layers you provide decide which runtime clients end up in the bundle.",
  }),
  api({
    title: "A catch-all like R2.AllBindings would bundle every client",
    code: ALL_BINDINGS,
    quiet: true,
    marks: [{ kind: "circle", find: "R2.AllBindings", label: "every R2 client, in every bundle", side: "right", tone: "bad" }],
    req: PROVIDED,
    notes:
      "That's why there's no R2.AllBindings or Queues.AllBindings. A catch-all would be convenient, but it would pull every client for every operation into every bundle, whether you call it or not.",
  }),
  api({
    title: "So you provide only the bindings you actually use",
    snippet: "api-07-worker.ts",
    quiet: true,
    marks: [
      {
        kind: "box",
        find: "R2.ReadBucketBinding,",
        to: "Queues.WriteQueueBinding,",
        label: "just what you use",
        side: "right",
        tone: "good",
      },
    ],
    req: PROVIDED,
    notes:
      "So you provide the specific bindings, one per capability. It's a little more typing, and it keeps each bundle down to exactly the code it runs.",
  }),
  api({
    title: "The right bindings also depend on where it runs",
    snippet: "api-10-lambda.error.ts",
    error: { hide: true },
    req: [...PROVIDED.slice(0, 2), WORKER],
    notes: "Which bindings are right also depends on where the program runs. The program itself doesn't care, so let's swap Cloudflare.Worker for AWS.Lambda.Function.",
  }),
  api({
    title: "It won't compile, because the native bindings need a Worker",
    snippet: "api-10-lambda.error.ts",
    error: { pick: firstLine("Type 'WorkerEnvironment'") },
    req: [...PROVIDED.slice(0, 2), { ...WORKER, state: "bad", note: "a Lambda Function isn't a Worker" }],
    notes:
      "The native binding layers require a Cloudflare Worker, and a Lambda Function can't provide one. The type checker catches it before anything is deployed.",
  }),
  api({
    title: "Swap the native bindings for HTTP, and it runs anywhere",
    snippet: "api-11-http.error.ts",
    // TODO: fails today: Cloudflare *Http layers also need CloudflareEnvironment and Self,
    // which AWS.Lambda.Function doesn't provide yet.
    error: { hide: true },
    req: [
      met(READ, "ReadBucketHttp\nmints an R2 read-only API token"),
      met(WRITE, "WriteQueueHttp\nmints a Queues write-only API token"),
    ],
    notes:
      "Swap each binding layer for its HTTP twin. ReadBucketHttp and WriteQueueHttp call Cloudflare's API instead of a native binding, so they don't need a Worker, and the Cloudflare.Worker requirement disappears. The permission changes with the layer too: each one mints an API token scoped to exactly what the code declared. Same program, different runtime, different layer. That's the other reason there's no AllBindings: the right implementation depends on the environment you're running in, so you choose it.",
  }),
  lang({
    group: "phase-callback",
    title: "Remember the phase rule from our imaginary language?",
    src: { code: COLORED_BAD },
    marks: [{ kind: "strike", find: "Bucket()", label: "can't create a resource at runtime", side: "right", tone: "bad" }],
    notes:
      "Before we deploy, remember the rule from our imaginary language. Construction and runtime are different colors, and creating a bucket inside a request was a compile error.",
  }),
  lang({
    group: "phase-callback",
    title: "And construction can't call runtime code either",
    src: { code: COLORED_EARLY },
    quiet: true,
    marks: [{ kind: "strike", find: 'bucket.get("hello.txt")', label: "no request yet", side: "right", tone: "bad" }],
    notes:
      "And the rule goes both ways. Reading the bucket is runtime code. Construction runs at deploy time, before there's any request, so calling it there should be an error too.",
  }),
  api({
    title: "So let's make that mistake in Alchemy",
    snippet: "api-08-construct.error.ts",
    marks: [{ kind: "underline", find: 'yield* uploads.get("hello.txt");', label: "at deploy time", side: "right", tone: "bad" }],
    error: { hide: true },
    req: [...PROVIDED, { name: "RuntimeContext", note: "only exists during a request" }],
    notes:
      "Let's make exactly that mistake in the Worker: read the bucket during construction, at deploy time, when there's no request yet. Req picks up RuntimeContext.",
  }),
  api({
    title: "It won't compile, because a Worker can't provide RuntimeContext",
    snippet: "api-08-construct.error.ts",
    error: { pick: firstLine("Type 'RuntimeContext'") },
    req: [...PROVIDED, { name: "RuntimeContext", state: "bad", note: "only exists during a request" }],
    notes:
      "A Worker's constructor runs at deploy time and cold start, with no request, so it can't provide RuntimeContext. Reading the bucket there is a type error, just like in our imaginary language.",
  }),
  api({
    title: "Unless you opt out explicitly (don't do this)",
    snippet: "api-09-phantom.ts",
    req: [...PROVIDED, PHANTOM],
    notes:
      "You can still make the call, but only by providing RuntimeContext.phantom: an explicit opt-out that squashes the error, like ts-expect-error. It's there for emergencies. Don't do this.",
  }),
  api({
    title: "But what actually creates the bucket?",
    snippet: "api-07-worker.ts",
    marks: [{ kind: "circle", find: 'R2.Bucket("Uploads")', tone: "construct" }],
    req: PROVIDED,
    notes:
      "Drop the opt-out, we're done with that. We've seen exactly what ends up in the Worker's bundle. But nothing in it creates the bucket. So what does declaring one actually do?",
  }),
  api({
    title: "Declaring a resource just yields a plain piece of data",
    snippet: "api-07-worker.ts",
    marks: [{ kind: "circle", find: 'R2.Bucket("Uploads")', label: "a type, a name, and props", side: "right", tone: "construct" }],
    req: PROVIDED,
    notes:
      "A resource in Alchemy is just data: its type, its name, and its props. Yielding it doesn't call any cloud API.",
  }),
  api({
    title: "…that asks for a provider to create it",
    snippet: "api-07-worker.ts",
    marks: [
      { kind: "underline", find: 'R2.Bucket("Uploads")', label: "needs R2.BucketProvider", side: "right", tone: "construct" },
      { kind: "underline", find: 'Queues.Queue("Jobs")', label: "needs Queues.QueueProvider", side: "right", tone: "construct" },
    ],
    req: [BUCKET, ...PROVIDED.slice(0, 1), QUEUE, ...PROVIDED.slice(1)],
    notes:
      "And it expresses a requirement: a provider that knows how to create, update and delete that kind of resource. R2.BucketProvider, Queues.QueueProvider. They show up in Req like any other requirement.",
  }),
  api({
    title: "Unlike a CDK construct, none of the provisioning code is in here",
    snippet: "api-07-worker.ts",
    marks: [
      {
        kind: "box",
        find: 'const bucket = yield* R2.Bucket("Uploads");',
        to: "const jobs = yield* Queues.WriteQueue(queue);",
        label: "no create, update, or delete",
        side: "right",
        tone: "good",
      },
    ],
    req: [BUCKET, ...PROVIDED.slice(0, 1), QUEUE, ...PROVIDED.slice(1)],
    notes:
      "Compare that with where I started. A CDK construct carries all of its provisioning code with it. Here the resource is a description plus a requirement, and the code that actually provisions it lives somewhere else.",
  }),
  stack({
    title: "Now that we have a Worker, we need a Stack to deploy it",
    code: STACK_1,
    notes:
      "OK, so now that we actually have a Worker, how do we deploy it? We need an entry point for alchemy deploy: a Stack, in alchemy.run.ts. It starts with a name.",
  }),
  stack({
    title: "A Stack is a set of resources you deploy as one unit",
    code: STACK_1,
    marks: [{ kind: "circle", find: '"App"', label: "one app", side: "right", tone: "construct" }],
    notes:
      "So what is a Stack? It's the root of the program: a collection of resources that are deployed, updated and destroyed together, as one unit.",
  }),
  stack({
    title: "…and each stage is its own isolated copy of it",
    code: STACK_1,
    marks: [{ kind: "circle", find: '"App"', label: "one app", side: "right", tone: "construct" }],
    panel: {
      title: "One Stack, many stages",
      items: [
        { title: "alchemy deploy --stage dev-sam", body: "your own copy, while you work", tone: "runtime" },
        { title: "alchemy deploy --stage pr-42", body: "a preview for every pull request", tone: "construct" },
        { title: "alchemy deploy --stage prod", body: "production", tone: "good" },
      ],
    },
    notes:
      "And every deploy targets a stage. Each stage is a separate, isolated instance of the same Stack, with its own resources and its own state. Your dev copy, a preview per pull request, and production never share a resource.",
  }),
  stack({
    title: "We give it the providers that create the resources",
    code: STACK_2,
    notes: "Next, the providers: the code that actually creates, updates and deletes resources. Cloudflare.providers() is every Cloudflare provider there is.",
  }),
  stack({
    title: "All of them, because this code only runs locally",
    code: STACK_2,
    marks: [{ kind: "box", find: "providers: Cloudflare.providers(),", label: "all of them", side: "right", tone: "construct" }],
    notes:
      "Unlike the bindings, we don't have to be precise here. The Stack only runs on your machine, or in CI, during deploy. None of it ships, so none of it needs to be tree-shaken.",
  }),
  stack({
    title: "…and a place to remember what it deployed",
    code: STACK_3,
    notes:
      "Then state: where Alchemy records what it deployed for each stage, so the next deploy knows what to create, update or delete. Here it's a local file; in CI you'd use a shared store.",
  }),
  stack({
    title: "Then it yields the Worker, and its providers bubble up",
    code: STACK_4,
    req: [met(BUCKET, "Cloudflare.providers()"), met(QUEUE, "Cloudflare.providers()")],
    notes:
      "Finally, the program itself: it yields our Worker. The Worker's remaining requirements, R2.BucketProvider and Queues.QueueProvider, bubble up to the Stack, and the providers we gave it satisfy them.",
  }),
  {
    kind: "code",
    group: "stack",
    file: "alchemy.run.ts",
    title: "…and returns what we want to know, like its URL",
    src: { snippet: "stack.ts", regions: ["show"] },
    req: { label: REQ_LABEL, items: [met(BUCKET, "Cloudflare.providers()"), met(QUEUE, "Cloudflare.providers()")] },
    notes: "And it returns the outputs we care about, like the Worker's URL, printed after every deploy.",
  },
  {
    kind: "code",
    group: "stack",
    file: "alchemy.run.ts",
    title: "The Worker is bundled on its own, with only its runtime code",
    src: { snippet: "stack.ts", regions: ["show"] },
    marks: [{ kind: "underline", find: "yield* Api", label: "bundled from its own import.meta.url", side: "right", tone: "runtime" }],
    panel: {
      title: "What the Worker bundle contains",
      items: [
        { title: "src/Api.ts", body: "from its import.meta.url", tone: "runtime" },
        { title: "ReadBucketBinding, WriteQueueBinding", body: "just their runtime clients", tone: "construct" },
        { title: "Providers, state, the Stack", body: "not included: they only run in alchemy deploy", tone: "good" },
      ],
    },
    notes:
      "The Worker is bundled separately, starting from its own import.meta.url. So it never pulls in the Stack, the providers, or the state store. Only the runtime code it needs. Remember Punchcard shipping the whole CDK? This is the fix.",
  },

  // Act 6: the compiler
  {
    kind: "board",
    board: "pipeline",
    stage: 0,
    title: "TypeScript checks it, and alchemy deploy compiles it",
    notes:
      "alchemy deploy acts as the compiler of your application. TypeScript does the static analysis with Effect and Layer types; running the program just builds the graph of resources and bindings, which is diffed into a plan you review.",
  },

  {
    kind: "code",
    group: "deploy",
    file: "terminal",
    lang: "ansi",
    title: "alchemy deploy runs the Stack and shows you a plan",
    src: { code: DEPLOY_PLAN },
    marks: [{ kind: "box", find: "+ Api (Cloudflare.Worker)", to: "  + Jobs", label: "the bindings, too", side: "right", tone: "construct" }],
    notes:
      "Now deploy. alchemy deploy runs the Stack's construction phase on your machine. That run discovers every resource and binding, and diffs them against the state into a plan: three resources to create, and the Worker's two bindings.",
  },
  {
    kind: "code",
    group: "deploy",
    file: "terminal",
    lang: "ansi",
    title: "Approve it, and everything is created and wired together",
    src: { code: DEPLOY_APPLIED },
    notes:
      "Approve it, and the providers do the work: the bucket, the queue, then the Worker with its bindings attached. One program, deployed.",
  },

  // Act 7: components
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
    title: "In Alchemy, you can declare your own requirement",
    src: { snippet: "links.ts", regions: ["service"] },
    notes:
      "ReadBucket and WriteQueue are just requirements, and you can declare your own. Links is an interface: get a link by its code. It says nothing about where links are stored.",
  },
  {
    kind: "code",
    group: "links",
    file: "src/Links.ts",
    title: "…and a Layer that builds its infrastructure",
    src: { snippet: "links.ts", regions: ["layer"] },
    tints: [{ from: "const db = yield*", to: "const sql = yield*", tone: "construct" }],
    notes:
      "A Layer implements it, with the same two phases: construction declares a D1 database and a binding to it, and the runtime part is the interface the application calls. That Layer is a component: infrastructure and the code that uses it, together.",
  },
  {
    kind: "code",
    group: "app",
    file: "src/Shorty.ts",
    title: "The Worker only asks for the interface",
    src: { snippet: "app-d1.ts", regions: ["show"] },
    marks: [{ kind: "circle", find: "yield* Links", tone: "construct" }],
    req: { label: REQ_LABEL, items: [{ name: "Links", state: "met", note: "LinksD1\na D1 database" }] },
    notes: "The Worker just needs Links. LinksD1 provides it, bringing its database along.",
  },
  {
    kind: "code",
    group: "app",
    file: "src/Shorty.ts",
    title: "Swap the infrastructure and keep the logic",
    src: { snippet: "app-neon.ts", regions: ["show"] },
    req: { label: REQ_LABEL, items: [{ name: "Links", state: "met", note: "LinksNeon\nNeon Postgres over Hyperdrive" }] },
    notes: "Swap the Layer and the infrastructure changes underneath: D1, Neon, DynamoDB. The business logic doesn't change. We'll do this for real in the demo.",
  },
  {
    kind: "code",
    group: "future",
    pseudo: true,
    title: "Today it's TypeScript and Effect, and tomorrow a language",
    src: { code: COLORED_APP },
    fontSize: 40,
    quiet: true,
    notes:
      "This all serves the original goal: a cloud programming language without new syntax. The TypeScript and Effect DSL is the foundation that a real syntax, with first-class colored functions, can sit on later. Now let's build something.",
  },
];
