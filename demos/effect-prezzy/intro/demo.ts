/**
 * The live demo: building Shorty the way an agent would. Every entry is one
 * keypress and one change; code is cut from the type-checked app in
 * `snippets/shorty/`, terminal output is written out here, and the browser
 * shows screenshots from `assets/`.
 */
import type { StepSpec } from "./steps.ts";

// Terminal colours, matching the CLI.
const T = {
  ok: "\x1b[38;5;113m",
  bad: "\x1b[38;5;203m",
  soft: "\x1b[38;5;150m",
  accent: "\x1b[38;5;173m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};
const $ = (cmd: string) => `${T.dim}$${T.reset} ${cmd}`;
const TABS = ["agent", "dev", "test"];

/** A terminal step whose last `fresh` lines are new. */
const term = (s: { title: string; notes: string; lines: string[]; fresh?: number; tab?: number; group?: string }): StepSpec => ({
  kind: "terminal",
  title: s.title,
  notes: s.notes,
  group: s.group ?? `term-${s.tab ?? 0}`,
  tabs: TABS,
  active: s.tab ?? 0,
  lines: s.lines.join("\n"),
  fresh: s.fresh,
});

/** A code step from the Shorty app: `file` is the label, `regions` what's shown. */
const code = (s: {
  title: string;
  notes: string;
  file: string;
  snippet: string;
  regions?: string[];
  marks?: Extract<StepSpec, { kind: "code" }>["marks"];
  error?: Extract<StepSpec, { kind: "code" }>["error"];
  group?: string;
}): StepSpec => ({
  kind: "code",
  group: s.group ?? `demo-${s.file}`,
  file: s.file,
  title: s.title,
  src: { snippet: `shorty/${s.snippet}`, regions: s.regions ?? ["show"] },
  marks: s.marks,
  error: s.error,
  notes: s.notes,
});

const TSC_ERROR = [
  $("tsc --noEmit"),
  `${T.bad}src/Api.ts:22:44${T.reset} - ${T.bad}error${T.reset} TS2322:`,
  `  Type 'LinkStoreError' is not assignable to type 'never'.`,
  ``,
  `${T.dim}Found 1 error.${T.reset}`,
];
const TSC_OK = [$("tsc --noEmit"), `${T.ok}✓${T.reset} no errors`];
const TEST_START = [$("bun test"), `${T.dim}deploying Shorty to a local stage…${T.reset}`];
const TEST_OK = [
  `${T.ok}✓${T.reset} creates and reads back a link ${T.dim}(38ms)${T.reset}`,
  `${T.ok}✓${T.reset} a missing link is a typed LinkNotFound ${T.dim}(9ms)${T.reset}`,
  `${T.ok}✓${T.reset} lists every link ${T.dim}(12ms)${T.reset}`,
  ``,
  `${T.ok}3 pass${T.reset} ${T.dim}· 0 fail · 1.4s${T.reset}`,
];
const DEV = [
  $("alchemy dev"),
  `${T.ok}✓${T.reset} Api ${T.dim}(Cloudflare.Worker)${T.reset}    http://localhost:1337`,
  `${T.ok}✓${T.reset} Db  ${T.dim}(Cloudflare.D1.Database)${T.reset} local`,
];
const DEV_WEB = [...DEV, `${T.ok}✓${T.reset} Web ${T.dim}(Cloudflare.Website)${T.reset}   http://localhost:5173`];
const PLAN = [
  $("alchemy deploy --stage prod"),
  `${T.ok}✓${T.reset} Plan ready ${T.dim}(0.9s)${T.reset}`,
  ``,
  `${T.accent}${T.bold}Deploy${T.reset}${T.dim} · ${T.reset}${T.ok}4 to create${T.reset}`,
  `${T.ok}+${T.reset} ${T.bold}Postgres${T.reset} ${T.dim}(Neon.Project)${T.reset}`,
  `${T.ok}+${T.reset} ${T.bold}Pool${T.reset} ${T.dim}(Cloudflare.Hyperdrive)${T.reset}`,
  `${T.ok}+${T.reset} ${T.bold}Api${T.reset} ${T.dim}(Cloudflare.Worker)${T.reset}`,
  `  ${T.ok}+${T.reset} ${T.soft}Pool${T.reset}`,
  `${T.ok}+${T.reset} ${T.bold}Web${T.reset} ${T.dim}(Cloudflare.Website)${T.reset}`,
  ``,
  `${T.bold}Deploy?${T.reset}  ${T.accent}${T.bold}› Deploy${T.reset}  ${T.dim}Cancel${T.reset}`,
];
const APPLIED = [
  $("alchemy deploy --stage prod"),
  `${T.ok}✓${T.reset} Postgres ${T.dim}(Neon.Project)${T.reset} created ${T.dim}(4.1s)${T.reset}`,
  `${T.ok}✓${T.reset} Pool ${T.dim}(Cloudflare.Hyperdrive)${T.reset} created ${T.dim}(1.3s)${T.reset}`,
  `${T.ok}✓${T.reset} Api ${T.dim}(Cloudflare.Worker)${T.reset} created ${T.dim}(5.8s)${T.reset}`,
  `${T.ok}✓${T.reset} Web ${T.dim}(Cloudflare.Website)${T.reset} created ${T.dim}(7.2s)${T.reset}`,
  ``,
  `${T.ok}Stack deployed (4/4)${T.reset}`,
  `${T.dim}web:${T.reset} https://shorty-web-prod.workers.dev`,
];

export const demo: StepSpec[] = [
  // 1. The API: schema, then implementation
  {
    kind: "slide",
    layout: "section",
    title: "Let's build something",
    eyebrow: "Demo",
    heading: "Let's build something",
    subtitle: "A link shortener, built the way an agent would",
    notes: "Let's build Shorty, a link shortener, the way you'd build it with an agent: API first, tests on every change, then a website, then production.",
  },
  code({
    title: "Start with the data, a Link",
    notes: "Everything starts from the schema. A Link is a code, a URL and a timestamp, and a missing link is a typed error that becomes a 404 over HTTP.",
    file: "src/Link.ts",
    snippet: "Link.ts",
    regions: ["link"],
  }),
  code({
    title: "Then the HTTP API, as a schema",
    notes:
      "The API is a value: three endpoints, create, get and list. The Worker serves this exact value, and the tests and the website will call it with a client derived from it.",
    file: "src/ShortyApi.ts",
    snippet: "ShortyApi.ts",
    regions: ["endpoints"],
  }),
  code({
    title: "Storage is a service, so the API never names a database",
    notes: "Links is an interface. The Worker will depend on this, never on a specific database.",
    file: "src/Links.ts",
    snippet: "Links.ts",
    regions: ["service"],
  }),
  code({
    title: "The Worker implements each endpoint",
    notes: "The agent writes the Worker: yield Links, and implement each endpoint by calling it.",
    file: "src/Api.ts",
    snippet: "ApiDraft.error.ts",
    regions: ["handlers", "provide"],
    error: { hide: true },
    group: "demo-api",
  }),

  // 2. The loop: type-check, fix, test
  term({
    title: "The agent checks its work with tsc first",
    notes: "Before anything runs, the agent type-checks. It's the fastest signal there is: well under a second.",
    lines: TSC_ERROR,
  }),
  code({
    title: "create can fail with a LinkStoreError the API doesn't declare",
    notes:
      "And it caught something real. The storage can fail, but the API contract doesn't have that error. Effect puts errors in the type, so this isn't a runtime surprise: it's a compile error.",
    file: "src/Api.ts",
    snippet: "ApiDraft.error.ts",
    regions: ["handlers", "provide"],
    error: { below: true, pick: (lines) => (lines.some((l) => l.includes("'LinkStoreError' is not assignable")) ? ["Type 'LinkStoreError' is not assignable to type 'never'."] : []) },
    group: "demo-api",
  }),
  code({
    title: "So the agent decides what that failure means",
    notes: "The agent fixes it: a storage failure here is a defect, so it dies and the platform returns a 500.",
    file: "src/Api.ts",
    snippet: "Api.ts",
    regions: ["handlers", "provide"],
    marks: [{ kind: "underline", find: "links.create(payload.url).pipe(Effect.orDie)", tone: "good" }],
    group: "demo-api",
  }),
  term({ title: "Type-check again…", notes: "Re-run tsc.", lines: TSC_OK }),
  code({
    title: "Now a test, against the real API",
    notes:
      "Types can't tell us the endpoints behave, so the agent writes a test. It deploys the whole Stack and calls it through the same typed client the website will use.",
    file: "test/api.test.ts",
    snippet: "api.test.ts",
  }),
  code({
    title: "dev: true runs it on your machine",
    notes:
      "dev: true deploys to local simulators instead of the cloud: a local Worker, a local D1. No accounts, no waiting for DNS. That's what makes this loop fast enough for an agent.",
    file: "test/api.test.ts",
    snippet: "api.test.ts",
    marks: [{ kind: "circle", find: "dev: true", label: "local, in seconds", side: "right", tone: "good" }],
  }),
  term({
    title: "The agent runs the tests…",
    notes: "bun test deploys the Stack to a local stage.",
    tab: 2,
    lines: TEST_START,
  }),
  term({
    title: "…and they pass, in about a second",
    notes: "Three tests, about a second and a half, including standing up the Worker and the database. That's the loop: types, then tests, over and over.",
    tab: 2,
    lines: [...TEST_START, ...TEST_OK],
    fresh: TEST_OK.length,
  }),

  // 3. A website
  code({
    title: "Now a website, added to the Stack",
    notes: "Next the website. It's one more resource in the Stack, and it gets the API's URL as an environment variable.",
    file: "alchemy.run.ts",
    snippet: "StackWeb.ts",
    marks: [{ kind: "underline", find: 'yield* Cloudflare.Website.Vite("Web"', tone: "construct" }],
  }),
  code({
    title: "It calls the API through the same typed client",
    notes: "The website calls the API with a client derived from ShortyApi. Rename an endpoint and the website stops compiling.",
    file: "web/src/client.ts",
    snippet: "client.ts",
  }),
  term({
    title: "alchemy dev runs it all locally",
    notes: "alchemy dev brings up the Worker, the database and the website locally, and reloads on every save.",
    tab: 1,
    lines: DEV_WEB,
  }),
  { kind: "browser", title: "Shorty, running locally", url: "http://localhost:5173", image: "01-api-browser-3.png", notes: "Here's the website, already talking to the local API." },
  {
    kind: "browser",
    title: "Shorten another link",
    url: "http://localhost:5173",
    image: "02-d1-browser-1.png",
    notes: "Shorten a link: the website calls the Worker, the Worker writes to the local database.",
  },

  // 4. Postgres, then production
  code({
    title: "For production, let's use Postgres on Neon",
    notes: "For production I want Postgres. Links is a service, so this is a one-word change: provide the Neon layer instead of D1.",
    file: "src/Api.ts",
    snippet: "ApiNeon.ts",
    regions: ["handlers", "provide"],
    marks: [{ kind: "underline", find: "NeonStorage", label: "was D1Storage", side: "right", tone: "construct" }],
    group: "demo-api",
  }),
  code({
    title: "NeonStorage brings its own infrastructure",
    notes:
      "And the layer brings its infrastructure with it: a Neon project and a Hyperdrive pool, running the same migrations. The Worker's code didn't change.",
    file: "src/Storage.ts",
    snippet: "Storage.ts",
    regions: ["neon"],
  }),
  term({ title: "Type-check…", notes: "Types first, as always.", lines: TSC_OK, group: "tsc-2" }),
  term({
    title: "…and the same tests pass against Postgres",
    notes: "The same tests, unchanged, now against Postgres.",
    tab: 2,
    lines: [...TEST_START, ...TEST_OK],
    fresh: TEST_OK.length,
    group: "test-2",
  }),
  term({
    title: "Deploy to production, starting with a plan",
    notes: "alchemy deploy runs the Stack and shows the plan: Neon, Hyperdrive, the Worker with its binding, and the website.",
    lines: PLAN,
    group: "deploy",
  }),
  term({
    title: "Approve it, and it's live",
    notes: "Approve, and the providers create everything in order.",
    lines: APPLIED,
    group: "deploy-applied",
  }),
  {
    kind: "browser",
    title: "Shorty, in production",
    url: "https://shorty-web-prod.workers.dev",
    image: "09-deploy-browser-3.png",
    notes: "And there it is, in production, backed by Postgres. Same code, same tests, from an empty folder.",
  },
];
