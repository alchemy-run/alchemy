/**
 * The second talk: the fastest feedback loop you can give an agent. A chat
 * app grows one piece at a time (Worker → Durable Object rooms over
 * WebSockets → R2 uploads → a queue into Postgres on Neon), and the same
 * end-to-end test follows it from the laptop, to a pull request's own copy,
 * to staging and prod. `intro/build.ts loop` resolves this into
 * `out/capture/loop/intro.json`; open it with `?deck=loop` in the presenter.
 *
 * Code comes from `snippets/chat/` and is type-checked; `*.error.ts` must fail.
 */
import type { LoopPart, MiniGraph, MiniNode, Tone } from "../shared/intro.ts";
import type { CodeSpec, CommentSpec, LoopSpec, StepSpec, TerminalSpec } from "./steps.ts";

// ── helpers ──────────────────────────────────────────────────────────────

const loop = (title: string, notes: string, lit?: LoopPart[], focus?: LoopPart[]): LoopSpec => ({
  kind: "loop",
  title,
  notes,
  lit,
  focus: focus ?? lit,
  frames: 20,
});

/** A code step from the chat app in `snippets/chat/`. */
const chat = (s: {
  title: string;
  notes: string;
  snippet: string;
  file: string;
  group: string;
  fontSize?: number;
  regions?: string[];
  omit?: string[];
  marks?: CodeSpec["marks"];
  diagram?: MiniGraph;
  beside?: CodeSpec["beside"];
  links?: CodeSpec["links"];
  emphasize?: string[];
  error?: CodeSpec["error"];
  quiet?: boolean;
}): CodeSpec => ({
  kind: "code",
  group: s.group,
  file: s.file,
  title: s.title,
  src: { snippet: `chat/${s.snippet}`, regions: s.regions ?? ["show"], omit: s.omit },
  fontSize: s.fontSize,
  marks: s.marks,
  diagram: s.diagram,
  beside: s.beside,
  links: s.links,
  emphasize: s.emphasize,
  error: s.error,
  quiet: s.quiet,
  notes: s.notes,
  frames: s.diagram ? 45 : undefined,
});

/** Code written inline (config files, the AWS versions). */
const inline = (s: Omit<CodeSpec, "kind" | "src"> & { code: string }): CodeSpec => {
  const { code, ...rest } = s;
  return { kind: "code", src: { code }, ...rest };
};

// ── terminal output, in the CLI's own colors ─────────────────────────────
const T = { ok: "\x1b[38;5;113m", soft: "\x1b[38;5;150m", accent: "\x1b[38;5;173m", grey: "\x1b[38;5;102m", red: "\x1b[38;5;203m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };
const RULE = `${T.grey}${T.dim}${"─".repeat(52)}${T.reset}`;
const $ = (cmd: string) => `${T.dim}$${T.reset} ${cmd}`;
const res = (name: string, type: string) => `${T.bold}${name}${T.reset} ${T.dim}(${type})${T.reset}`;
const term = (s: Omit<TerminalSpec, "kind" | "lines"> & { lines: string[] }): TerminalSpec => ({
  kind: "terminal",
  ...s,
  lines: s.lines.join("\n"),
});

// ── the app's architecture, drawn beside the Worker ──────────────────────
const N = {
  chat: { id: "chat", title: "Chat", color: "#f38020" },
  room: { id: "room", title: "Room", color: "#e06c9f" },
  files: { id: "files", title: "Files", color: "#8b7cf6" },
  messages: { id: "messages", title: "Messages", color: "#e0a86b" },
  db: { id: "db", title: "Postgres", color: "#34d399" },
};
const at = (node: { id: string; title: string; color: string }, x: number, y: number, notes?: string[]): MiniNode => ({
  ...node,
  x,
  y,
  ...(notes ? { notes } : {}),
});
const CHAT = at(N.chat, 150, 330);
const ROOM = at(N.room, 560, 110);
const MESSAGES = at(N.messages, 560, 330);
const FILES = at(N.files, 150, 580);
const DB = at(N.db, 560, 580);
const E = {
  room: { from: "chat", to: "room", label: "Durable Object" },
  files: { from: "chat", to: "files", label: "read · write" },
  send: { from: "room", to: "messages", label: "send" },
  consume: { from: "messages", to: "chat", label: "consume" },
  db: { from: "chat", to: "db", label: "Hyperdrive" },
};
const card = (text: string, tone: Tone = "construct") => ({ text, tone });

const WORKER = { snippet: "Chat.ts", file: "src/Chat.ts", group: "chat", fontSize: 22 };
const ROOM_FILE = { snippet: "Room.ts", file: "src/Room.ts", group: "room", fontSize: 25 };

// ── act 0: the loop, introduced one piece at a time ─────────────────────
/** A map step that draws only `show`, everything lit. */
const reveal = (title: string, notes: string, show: LoopPart[], focus?: LoopPart[]): LoopSpec => ({
  kind: "loop",
  title,
  notes,
  show,
  focus,
  frames: 30,
});
const MACHINE: LoopPart[] = ["edit", "types", "local", "live", "feedback"];
const PULL: LoopPart[] = ["push", "pr", "prTest", "comment"];
const MAIN: LoopPart[] = ["merge", "staging", "stagingTest", "prod"];
const theLoop: StepSpec[] = [
  {
    kind: "slide",
    layout: "title",
    title: "The fastest feedback loop for agents",
    eyebrow: "Alchemy",
    heading: "The fastest feedback loop for agents",
    subtitle: "One program and one test file, from an edit to production",
    notes:
      "I'm Sam, I work on Alchemy. This talk is about what an AI agent needs to go fast and still ship things that work.",
  },
  {
    kind: "slide",
    layout: "section",
    title: "Agents write code faster than we can check it",
    heading: "Agents write code faster than we can check it",
    subtitle: "Writing code is no longer the slow part",
    notes:
      "Agents are very good at writing code now. What slows them down, and what makes them wrong, is everything that comes after: finding out whether the code actually works.",
  },
  reveal(
    "An agent can change your code in seconds",
    "Here's the agent. It edits code in seconds, and it'll happily tell you it's done.",
    ["edit"],
  ),
  reveal(
    "Getting that change safely into production takes much longer",
    "Over here is production. Between the two is everything that decides whether that edit was right. Each of those steps is feedback, and the agent can only move as fast as the slowest one it has to wait for.",
    ["edit", "prod"],
  ),
  reveal(
    "The type checker is the first thing that answers",
    "The first check is the type checker. It answers in milliseconds, and it points at the exact line. Every failure goes back to the agent, which fixes it and tries again.",
    ["edit", "types", "feedback", "prod"],
    ["types"],
  ),
  reveal(
    "Tests on emulated services answer in seconds",
    "Next, tests that run the whole app on your machine, against emulated cloud services. Seconds, free, and the agent can run them after every change.",
    ["edit", "types", "local", "feedback", "prod"],
    ["local"],
  ),
  reveal(
    "Tests against the real cloud catch what emulators miss",
    "Then the same tests against the real cloud, in a stage of their own. Slower, but that's where permissions, networking and real service behavior show up.",
    [...MACHINE, "prod"],
    ["live"],
  ),
  reveal(
    "A pull request gets its own copy of the app to test",
    "When it's green locally, the agent opens a pull request. CI deploys a copy of the app just for that PR, runs the same tests, and comments with a link to try it.",
    [...MACHINE, ...PULL, "prod"],
    PULL,
  ),
  reveal(
    "Merging runs the same tests again on staging",
    "Merging deploys staging and runs the same tests one more time. Only a green staging goes to prod.",
    [...MACHINE, ...PULL, ...MAIN],
    ["merge", "staging", "stagingTest"],
  ),
  loop(
    "This is every step between an edit and production",
    "That's the whole path. Three lanes: your machine, the pull request, and main.",
  ),
  loop(
    "Every failure goes straight back to the agent",
    "At every step, a failure is feedback the agent can read and act on. The faster and more precise that feedback, the faster it converges on something that works. The rest of this talk builds each of these steps.",
    undefined,
    ["feedback"],
  ),
];

// ── act 1: the app is one declarative program ───────────────────────────
const program: StepSpec[] = [
  chat({
    snippet: "Hello.ts",
    file: "src/Chat.ts",
    group: "chat",
    fontSize: WORKER.fontSize,
    title: "We'll build a chat app, starting with one Worker",
    notes: "Our example is a chat app on Cloudflare. It starts as the smallest thing that works: a Worker that says hello.",
    quiet: true,
  }),
  chat({
    snippet: "StackHello.ts",
    file: "alchemy.run.ts",
    group: "stack",
    title: "A Stack declares everything the app is made of",
    notes:
      "Next to it is the Stack. It lists what the app is made of, which providers can create it, and where its state lives. Right now that's one Worker.",
  }),
  term({
    group: "cli",
    title: "alchemy deploy makes the cloud match that code",
    lines: [
      $("alchemy deploy"),
      `${T.ok}✓${T.reset} Plan ready`,
      RULE,
      `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}1 to create${T.reset}`,
      ``,
      `${T.ok}+${T.reset} ${res("Chat", "Cloudflare.Worker")}`,
      RULE,
      `${T.ok}✓${T.reset} ${res("Chat", "Cloudflare.Worker")} created`,
      `${T.ok}Stack deployed${T.reset} ${T.dim}{ url: "https://chat-dev-sam.workers.dev" }${T.reset}`,
    ],
    notes:
      "alchemy deploy compares the code with what's in the cloud and does whatever it takes to make them match. Here, that's creating one Worker.",
  }),
  term({
    group: "cli",
    title: "Running it again changes nothing",
    lines: [$("alchemy deploy"), `${T.ok}✓${T.reset} Plan ready`, RULE, `${T.dim}No changes${T.reset}`],
    notes:
      "Run it again and nothing happens. The code describes the end state, not the steps to get there, so it's always safe to run. An agent can't break anything by deploying twice.",
  }),
  term({
    group: "cli",
    title: "alchemy destroy removes every piece of it",
    lines: [
      $("alchemy destroy"),
      `${T.red}-${T.reset} ${res("Chat", "Cloudflare.Worker")} deleted`,
      `${T.ok}Stack destroyed${T.reset}`,
    ],
    notes: "And destroy removes everything the Stack created. Nothing left behind to clean up by hand.",
  }),
  term({
    group: "cli",
    title: "alchemy dev runs the same program on your machine",
    lines: [
      $("alchemy dev"),
      `${T.ok}✓${T.reset} ${res("Chat", "Cloudflare.Worker")} ${T.dim}→${T.reset} http://localhost:1337`,
      `${T.dim}watching for changes…${T.reset}`,
    ],
    notes:
      "And alchemy dev runs the same Stack locally, with emulated Cloudflare services. Because the whole app is one declarative program, an agent can stand it up, tear it down, and run it locally, all by itself.",
  }),
];

// ── act 2: the app grows; each binding is typed ──────────────────────────
/** The consumer on AWS: a Lambda fed by SQS (shown, not type-checked). */
const ARCHIVE = `export default AWS.Lambda.Function(
  "Archive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const messages = yield* Messages;

    yield* SQS.consumeQueueMessages(messages, (batch) =>
      Stream.runForEach(batch, save),
    );
  }),
);`;

const grow: StepSpec[] = [
  chat({
    ...ROOM_FILE,
    title: "Each chat room is a Durable Object that accepts WebSockets",
    omit: ["archive", "message"],
    notes:
      "Now let's make it a chat. Each room is a Durable Object: one small stateful server per room name. Its fetch upgrades the request to a WebSocket.",
  }),
  chat({
    ...ROOM_FILE,
    title: "When one socket sends a message, the room sends it to everyone",
    omit: ["archive", "send"],
    notes:
      "When a message arrives on any socket, the room sends it to every socket connected to it. These sockets hibernate, so an idle room costs nothing.",
  }),
  chat({
    ...WORKER,
    title: "The Worker hands each room's sockets to its Durable Object",
    omit: ["files", "sql", "consume", "upload", "history"],
    diagram: { nodes: [CHAT, ROOM], edges: [E.room], cards: [card("durable_object_namespaces: Room")] },
    emphasize: ["const rooms", "rooms.getByName"],
    notes:
      "Back in the Worker, yield the Room. That one line is a binding: at deploy it adds the Durable Object namespace to the Worker and runs the class migration. Then /rooms/:name routes to that room.",
  }),
  chat({
    ...WORKER,
    title: "Uploads go to an R2 bucket the Worker can read and write",
    omit: ["sql", "consume", "history"],
    diagram: {
      nodes: [CHAT, ROOM, FILES],
      edges: [E.room, E.files],
      cards: [card("r2_buckets: Files → chat-dev-sam-files")],
    },
    emphasize: ["R2.Bucket", "R2.ReadWriteBucket", "files.put"],
    notes:
      "People want to share files, so add an R2 bucket. ReadWriteBucket is the binding: it asks for read and write access, and at deploy it adds the bucket to the Worker.",
  }),
  chat({
    snippet: "ChatRead.error.ts",
    file: WORKER.file,
    group: WORKER.group,
    fontSize: WORKER.fontSize,
    title: "Ask for read-only access and the upload stops compiling",
    error: { pick: (lines) => lines.filter((line) => line.includes("'put'")).slice(0, 1) },
    emphasize: ["R2.ReadBucket(bucket)"],
    notes:
      "Ask only for read access, and the client you get back has no put. The upload is now a type error. The agent finds out in milliseconds, in the editor, before anything deploys.",
  }),
  chat({
    snippet: "ChatS3.ts",
    file: WORKER.file,
    group: "chat-aws",
    fontSize: 22,
    title: "On AWS, the same kind of line writes an IAM policy",
    omit: ["route"],
    beside: {
      file: "generated at deploy",
      lang: "yaml",
      src: {
        code: `# IAM policy on the Worker's role
Effect: Allow
Action: s3:PutObject
Resource: arn:aws:s3:::chat-dev-sam-files/*`,
      },
    },
    links: [{ from: "AWS.S3.PutObject(bucket)", to: "s3:PutObject", tone: "good" }],
    notes:
      "A quick detour to AWS, where this is easier to see. Swap the bucket for S3 and ask for PutObject. At deploy, Alchemy gives the Worker an IAM role, and that one line becomes a policy statement: PutObject, on exactly this bucket.",
  }),
  chat({
    snippet: "ChatS3.ts",
    file: WORKER.file,
    group: "chat-aws",
    fontSize: 22,
    title: "…plus an environment variable with the bucket's name",
    omit: ["route"],
    beside: {
      file: "generated at deploy",
      lang: "yaml",
      src: {
        code: `# IAM policy on the Worker's role
Effect: Allow
Action: s3:PutObject
Resource: arn:aws:s3:::chat-dev-sam-files/*

# Worker environment
$BUCKET_NAME: chat-dev-sam-files`,
      },
    },
    links: [
      { from: "AWS.S3.PutObject(bucket)", to: "s3:PutObject", tone: "good" },
      { from: "putFile({", to: "$BUCKET_NAME", tone: "good" },
    ],
    notes:
      "It also sets $BUCKET_NAME, so putFile knows where to write. Nobody writes the policy or the variable by hand, so neither can drift from the code. Delete the line and the permission goes with it.",
  }),
  chat({
    ...ROOM_FILE,
    title: "Back on Cloudflare, each room also puts its messages on a queue",
    emphasize: ["archive"],
    notes:
      "Back to Cloudflare. We want history, so each room also sends every message to a queue. Queues.WriteQueue is another binding: send-only access to that queue.",
  }),
  chat({
    ...WORKER,
    title: "The Worker consumes that queue into Postgres on Neon",
    omit: ["route", "upload", "history", "fetch"],
    diagram: {
      nodes: [CHAT, ROOM, MESSAGES, FILES, DB],
      edges: [E.room, E.files, E.send, E.consume, E.db],
      cards: [card("queue consumer: Messages → Chat"), card("hyperdrive: Pool → Neon Db")],
    },
    emphasize: ["sql", "consumeQueueMessages", "messages", "Stream.runForEach"],
    notes:
      "The Worker consumes the queue in batches and inserts each message into Postgres. The database is a Neon project, reached through Hyperdrive. Consuming a queue is an event source: at deploy it registers the Worker as the queue's consumer.",
  }),
  inline({
    group: "aws-sqs",
    file: "src/Archive.ts",
    fontSize: 24,
    title: "On AWS, consuming a queue grants three permissions",
    code: ARCHIVE,
    beside: {
      file: "generated at deploy",
      lang: "yaml",
      src: {
        code: `# IAM policy on the Lambda's role
Effect: Allow
Action:
  - sqs:ReceiveMessage
  - sqs:DeleteMessage
  - sqs:GetQueueAttributes
Resource: arn:aws:sqs:…:chat-dev-sam-messages`,
      },
    },
    links: [{ from: "SQS.consumeQueueMessages", to: "sqs:ReceiveMessage", tone: "good" }],
    notes:
      "The same detour for event sources. On AWS the consumer is a Lambda, and consumeQueueMessages grants exactly the three actions a consumer needs, on exactly this queue.",
  }),
  inline({
    group: "aws-sqs",
    file: "src/Archive.ts",
    fontSize: 24,
    title: "…and creates the event source mapping that triggers it",
    code: ARCHIVE,
    beside: {
      file: "generated at deploy",
      lang: "yaml",
      src: {
        code: `# IAM policy on the Lambda's role
Effect: Allow
Action:
  - sqs:ReceiveMessage
  - sqs:DeleteMessage
  - sqs:GetQueueAttributes
Resource: arn:aws:sqs:…:chat-dev-sam-messages

# Event source mapping
EventSourceArn: arn:aws:sqs:…:chat-dev-sam-messages
FunctionName: chat-dev-sam-archive`,
      },
    },
    links: [
      { from: "SQS.consumeQueueMessages", to: "sqs:ReceiveMessage", tone: "good" },
      { from: "SQS.consumeQueueMessages", to: "EventSourceArn", tone: "good" },
    ],
    notes:
      "It also creates the event source mapping that invokes the Lambda with each batch. One line of code, and the trigger and its permissions exist exactly as long as that line does.",
  }),
  chat({
    ...WORKER,
    title: "History is one query away",
    omit: ["route", "upload", "consume", "files"],
    diagram: {
      nodes: [CHAT, ROOM, MESSAGES, FILES, DB],
      edges: [E.room, E.files, E.send, E.consume, E.db],
    },
    emphasize: ["history", "SELECT", "rows"],
    notes: "Back on Cloudflare, /history/:room reads a room's messages back out of Postgres.",
  }),
];

// ── act 3: one test for the whole app, local or live ─────────────────────
const TEST = { snippet: "chat.test.ts", file: "test/chat.test.ts", group: "test", fontSize: 27 };
const tests: StepSpec[] = [
  loop(
    "Now the agent needs a way to check its own work",
    "That's a real app: a Worker, Durable Objects, WebSockets, a bucket, a queue and a database. Types catch a lot, but the agent still needs to know the whole thing works. That's the next two boxes.",
    ["local", "live"],
  ),
  chat({
    ...TEST,
    title: "A test deploys the whole Stack before it runs",
    omit: ["dev", "test", "stage"],
    notes:
      "An end-to-end test starts by deploying the same Stack. deploy(Stack) runs once for the file, so every test shares one deployment.",
  }),
  chat({
    ...TEST,
    title: "Then it talks to the app the way a user would",
    omit: ["dev", "history", "stage"],
    notes:
      "Then it uses the app like a person would. Alice and Bob join the lobby over WebSockets, Alice says hi, Bob hears it. That goes through the Worker and the Durable Object.",
  }),
  chat({
    ...TEST,
    title: "It checks the queue and the database too",
    omit: ["dev", "stage"],
    notes:
      "And the message should land in history, which means it went through the queue, the consumer and Postgres. One test covers every piece of the app.",
  }),
  term({
    group: "test-run",
    title: "By default it runs against the real cloud, in its own stage",
    lines: [
      $("pnpm test"),
      `${T.dim}deploying Chat to stage ${T.reset}${T.bold}test_sam${T.reset}`,
      `${T.ok}✓${T.reset} a message reaches everyone in the room`,
      ``,
      `${T.ok}1 passed${T.reset}`,
    ],
    notes:
      "Run it, and it deploys to a stage of its own, test_sam, in the real cloud. Real Workers, real queues, a real Neon database. Nothing shared with your dev stage or anyone else's.",
  }),
  chat({
    snippet: "chat-dev.test.ts",
    file: TEST.file,
    group: "test-dev",
    fontSize: 30,
    title: "dev: true runs the same Stack on emulated services",
    emphasize: ["dev: true"],
    notes:
      "Set dev to true and the same file runs against emulated services instead: workerd for the Worker, Durable Objects, R2 and queues, locally. Same Stack, same test.",
  }),
  chat({
    snippet: "chat.test.ts",
    file: TEST.file,
    group: "test-dev",
    fontSize: 30,
    regions: ["make"],
    omit: ["stage"],
    title: "An environment variable decides where it runs",
    emphasize: ["dev: !!process.env.LOCAL"],
    notes:
      "Make it an environment variable, and the agent picks. Local while it iterates, live when it wants the real thing.",
  }),
  term({
    group: "test-run",
    title: "Emulated for speed, live for the real thing",
    lines: [
      $("LOCAL=1 pnpm test"),
      `${T.dim}starting Chat on ${T.reset}${T.bold}http://localhost:1337${T.reset}`,
      `${T.ok}✓${T.reset} a message reaches everyone in the room`,
      ``,
      $("pnpm test"),
      `${T.dim}deploying Chat to stage ${T.reset}${T.bold}test_sam${T.reset}`,
      `${T.ok}✓${T.reset} a message reaches everyone in the room`,
    ],
    fresh: 7,
    notes:
      "Both are one command away. Emulated is fast and free, so the agent can run it after every change. Live catches what emulation can't, like permissions and real network behavior.",
  }),
];

// ── act 4: every pull request gets its own copy ──────────────────────────
const PR_YAML = `on: pull_request

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      STAGE: pr-\${{ github.event.number }}
    steps:
      - uses: actions/checkout@v5
      - run: pnpm install
      - run: pnpm test`;
const PR_YAML_CLOSE = `on:
  pull_request:
    types: [opened, synchronize, closed]

jobs:
  test:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    env:
      STAGE: pr-\${{ github.event.number }}
    steps:
      - uses: actions/checkout@v5
      - run: pnpm install
      - run: pnpm test

  cleanup:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - run: pnpm alchemy destroy --stage pr-\${{ github.event.number }}`;
const ci: StepSpec[] = [
  term({
    group: "stages",
    title: "Every stage is a complete, isolated copy of the app",
    lines: [
      $("alchemy deploy --stage pr-42"),
      `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}6 to create${T.reset}`,
      ``,
      `${T.ok}+${T.reset} ${res("Room", "Cloudflare.DurableObject")}`,
      `${T.ok}+${T.reset} ${res("Files", "Cloudflare.R2.Bucket")}     ${T.soft}chat-pr-42-files${T.reset}`,
      `${T.ok}+${T.reset} ${res("Messages", "Cloudflare.Queues.Queue")} ${T.soft}chat-pr-42-messages${T.reset}`,
      `${T.ok}+${T.reset} ${res("Db", "Neon.Project")}             ${T.soft}chat-pr-42-db${T.reset}`,
      `${T.ok}+${T.reset} ${res("Pool", "Cloudflare.Hyperdrive")}    ${T.soft}chat-pr-42-pool${T.reset}`,
      `${T.ok}+${T.reset} ${res("Chat", "Cloudflare.Worker")}        ${T.soft}chat-pr-42-chat${T.reset}`,
    ],
    notes:
      "A stage is a name, like dev_sam, test_sam or pr-42. Every resource's physical name includes it, and every stage keeps its own state. Deploy a new stage and you get a whole new copy of the app.",
  }),
  chat({
    snippet: "chat.test.ts",
    file: TEST.file,
    group: "test-dev",
    fontSize: 30,
    regions: ["make"],
    title: "The test can take its stage from the environment",
    emphasize: ["stage: process.env.STAGE"],
    notes: "Let the test file read its stage from the environment. Unset, it's test_sam on your machine.",
  }),
  inline({
    group: "ci",
    file: ".github/workflows/pr.yml",
    lang: "yaml",
    fontSize: 30,
    title: "CI runs the same tests on a copy just for the pull request",
    code: PR_YAML,
    emphasize: ["STAGE: pr-", "pnpm test"],
    notes:
      "Then CI is one command. For pull request 42, STAGE is pr-42, so pnpm test deploys a copy of the app for that PR and runs the same tests against it. Set LOCAL too and CI runs it emulated instead.",
  }),
  inline({
    group: "ci",
    file: ".github/workflows/pr.yml",
    lang: "yaml",
    fontSize: 24,
    title: "Closing the pull request destroys that copy",
    code: PR_YAML_CLOSE,
    emphasize: ["closed", "cleanup", "alchemy destroy"],
    notes: "When the PR closes, destroy that stage. Every resource the PR created goes with it.",
  }),
];

// ── act 5: shared infrastructure, by reference ───────────────────────────
const DB_FILE = { snippet: "DbBranch.ts", file: "src/Db.ts", group: "db", fontSize: 25 };
const staging = (id: string, title: string, color: string, x: number) => at({ id, title, color }, x, 110);
const pr = (id: string, title: string, color: string, x: number, y: number) => at({ id, title, color }, x, y);
const SHARED: MiniGraph = {
  nodes: [
    staging("sChat", "Chat", "#f38020", 360),
    pr("w41", "pr-41", "#f38020", 120, 330),
    pr("w42", "pr-42", "#f38020", 360, 330),
    pr("w43", "pr-43", "#f38020", 600, 330),
    at({ id: "sDb", title: "Db", color: "#34d399" }, 360, 500),
    pr("d41", "pr-41", "#34d399", 120, 710),
    pr("d42", "pr-42", "#34d399", 360, 710),
    pr("d43", "pr-43", "#34d399", 600, 710),
  ],
  edges: [
    { from: "sChat", to: "w41" },
    { from: "sChat", to: "w42" },
    { from: "sChat", to: "w43" },
    { from: "sDb", to: "d41" },
    { from: "sDb", to: "d42" },
    { from: "sDb", to: "d43" },
  ],
  labels: [
    { text: "staging", x: 100, y: 122, tone: "construct" },
    { text: "staging", x: 100, y: 512, tone: "construct" },
  ],
};
const shared: StepSpec[] = [
  loop(
    "A new database for every pull request starts empty",
    "A full copy per PR is great for isolation, but a brand new database has no data in it. Real apps need realistic data to test against, and creating a database per PR is slow and costs money.",
    ["pr"],
  ),
  chat({
    snippet: "Db.ts",
    file: DB_FILE.file,
    group: DB_FILE.group,
    fontSize: DB_FILE.fontSize,
    title: "Right now every stage creates its own Neon project",
    notes: "Here's the database layer. Every stage creates its own Neon project, reached through Hyperdrive.",
    quiet: true,
  }),
  chat({
    ...DB_FILE,
    title: "A pull request branches staging's database instead",
    notes:
      "For a PR stage, reference staging's project with ref, which reads it from staging's state without owning it, and create a Neon branch in it. A branch is a copy-on-write fork of staging's data, ready in about a second.",
  }),
  chat({
    snippet: "ChatPreview.ts",
    file: WORKER.file,
    group: "preview",
    fontSize: 27,
    regions: ["top", "bottom"],
    title: "The Worker becomes a preview of staging's Worker",
    emphasize: ["preview", "Worker.ref"],
    notes:
      "Same idea for the Worker. In a PR stage, it's uploaded as a preview of staging's Worker, with its own URL and its own Durable Object state, instead of a whole new Worker.",
  }),
  {
    kind: "code",
    group: "shared",
    title: "Staging is shared, and every pull request branches off it",
    src: {
      code: `Cloudflare.Worker.ref("Chat", { stage: "staging" })
Neon.Project.ref("Db", { stage: "staging" })`,
    },
    fontSize: 26,
    diagram: SHARED,
    quiet: true,
    frames: 60,
    notes:
      "So staging is the one shared environment. Each PR gets a preview of its Worker and a branch of its database: realistic, isolated, and cheap enough to make for every PR.",
  },
  chat({
    snippet: "StackPr.ts",
    file: "alchemy.run.ts",
    group: "stack",
    fontSize: 26,
    title: "The Stack comments the preview link on the pull request",
    emphasize: ["GitHub.Comment", "PULL_REQUEST", "Preview deployed", "GitHub.providers"],
    notes:
      "Finally, a GitHub Comment is a resource too. When the Stack deploys for a PR, it posts the preview URL on it, and updates the same comment on every push.",
  }),
  {
    kind: "comment",
    title: "The agent and the reviewer both get a link to try",
    pr: { number: 42, title: "Add file uploads to rooms", branch: "agent/uploads" },
    checks: [{ name: "test", state: "passed", detail: "stage pr-42" }],
    comments: [
      {
        author: "alchemy",
        bot: true,
        lines: ["🚀 Preview deployed to https://pr-42-chat.sam.workers.dev"],
      },
    ],
    notes:
      "The PR shows green tests from its own copy, and a link to try it. The agent can read the check, and a reviewer can click the link and chat in the preview.",
  } satisfies CommentSpec,
];

// ── act 6: main → staging → prod ─────────────────────────────────────────
const MAIN_YAML = `on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: pnpm install
      - run: pnpm test
        env: { STAGE: staging }`;
const release: StepSpec[] = [
  inline({
    group: "main",
    file: ".github/workflows/main.yml",
    lang: "yaml",
    fontSize: 30,
    title: "Merging to main runs the same tests against staging",
    code: MAIN_YAML,
    emphasize: ["branches: [main]", "STAGE: staging"],
    notes: "On main, the same command runs with STAGE set to staging. Staging is updated and tested in one step.",
  }),
  inline({
    group: "main",
    file: ".github/workflows/main.yml",
    lang: "yaml",
    fontSize: 30,
    title: "Only a green staging reaches prod",
    code: `${MAIN_YAML}
      - run: pnpm alchemy deploy --stage prod`,
    emphasize: ["--stage prod"],
    notes: "And only if those tests pass does the same program deploy to prod.",
  }),
  loop(
    "One program and one test file, all the way to prod",
    "That's the loop. One program describes the whole app. One test file checks it on your machine, emulated or live, on every pull request's copy, and on staging. Every failure along the way is feedback the agent can act on.",
    undefined,
    ["edit", "types", "local", "live", "push", "pr", "prTest", "comment", "merge", "staging", "stagingTest", "prod", "feedback"],
  ),
];

export const steps: StepSpec[] = [...theLoop, ...program, ...grow, ...tests, ...ci, ...shared, ...release];
