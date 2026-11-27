/**
 * The hero's provider reel: one program, declared and proved once, served
 * from seven providers. It holds all three parts: the infrastructure, an AI
 * process, and the model's rules. The bank is the model the rest of the
 * page uses.
 *
 * The aggregate comes last: its lines are short, which leaves the card's
 * bottom-right corner free for the terminal that sits over it.
 *
 * Props are plain objects: a prop accepts the resource's Effect directly
 * (`cluster: Cluster`), so nothing has to be yielded first.
 *
 * ⟨0⟩ is the host, ⟨1⟩ the props it needs beyond `main`, and ⟨2⟩ the Bank
 * Layer that keeps the ledger in that provider's database.
 */
export const HOST_TEMPLATE = `export default ⟨0⟩(
  "Api",
  { main: import.meta.url⟨1⟩ },
  Effect.gen(function* () {
    const bank = yield* CustomerApi;
    return { fetch: bank.fetch };
  }).pipe(Effect.provide(⟨2⟩)),
);

export class FraudReview extends AI.Process<FraudReview>()(
  "FraudReview",
  { description: "Review one risky withdrawal." },
)\`
  Read the account with \${Bank.AccountSummary}.
  If it looks stolen, send \${Bank.FreezeAccount}.
\` {}

export class Account extends Domain.Aggregate("Account", {
  decide: {
    WithdrawMoney: (account, { amount }) =>
      amount > account.balance
        ? new InsufficientFunds()
        : [new MoneyWithdrawn({ amount })],
  },
  invariants: {
    NeverOverdrawn: ({ balance }) =>
      balance >= 0,
  },
}) {}`;

export interface HostResource {
  id: string;
  type: string;
  bindings?: string[];
}

export interface Host {
  /** Reel label: the provider. */
  label: string;
  values: [string, string, string];
  resources: HostResource[];
  url?: string;
}

export const HOSTS: Host[] = [
  {
    label: "Cloudflare",
    values: ["Cloudflare.Worker", "", "BankD1"],
    resources: [
      { id: "Ledger", type: "Cloudflare.D1Database" },
      { id: "Api", type: "Cloudflare.Worker", bindings: ["Ledger"] },
    ],
    url: "https://api.bank.workers.dev",
  },
  {
    label: "AWS",
    values: ["AWS.Lambda.Function", "", "BankDynamoDB"],
    resources: [
      { id: "Ledger", type: "AWS.DynamoDB.Table" },
      { id: "Api", type: "AWS.Lambda.Function", bindings: ["Ledger"] },
    ],
    url: "https://7xk2q.lambda-url.us-east-1.on.aws",
  },
  {
    label: "GCP",
    values: ["GCP.Run.Service", "", "BankFirestore"],
    resources: [
      { id: "Ledger", type: "GCP.Firestore.Database" },
      { id: "Api", type: "GCP.Run.Service", bindings: ["Ledger"] },
    ],
    url: "https://api-7xk2q-uc.a.run.app",
  },
  {
    label: "Kubernetes",
    values: ["Kubernetes.Deployment", ", cluster: Cluster, port: 3000", "BankFirestore"],
    resources: [
      { id: "Ledger", type: "GCP.Firestore.Database" },
      { id: "Api", type: "Kubernetes.Deployment", bindings: ["Ledger"] },
    ],
  },
  {
    label: "Fly",
    values: ["Fly.Service", "", "BankPostgres"],
    resources: [
      { id: "Ledger", type: "Fly.Postgres" },
      { id: "Api", type: "Fly.Service", bindings: ["Ledger"] },
    ],
    url: "https://bank-api.fly.dev",
  },
  {
    label: "Railway",
    values: ["Railway.Service", ", project: Project", "BankPostgres"],
    resources: [
      { id: "Project", type: "Railway.Project" },
      { id: "Ledger", type: "Railway.Postgres" },
      { id: "Api", type: "Railway.Service", bindings: ["Ledger"] },
    ],
    url: "https://api-production.up.railway.app",
  },
  {
    label: "Hetzner",
    values: ["Hetzner.Service", ", server: Box, port: 3000", "BankSQLite"],
    resources: [
      { id: "Box", type: "Hetzner.Server" },
      { id: "Ledger", type: "Hetzner.Volume" },
      { id: "Api", type: "Hetzner.Service", bindings: ["Ledger"] },
    ],
  },
];

/** The template with one host's values filled in. */
export const hostSource = (values: readonly string[]) =>
  HOST_TEMPLATE.replace(/⟨(\d)⟩/g, (_, i: string) => values[+i]!);

/**
 * The same program for narrow screens: the props sit one per line, the
 * prose wraps, and the aggregate's handlers are folded to their names, so
 * no line passes ~42 columns. Slot ⟨1⟩ holds the host's extra props on a line of their own.
 */
export const HOST_TEMPLATE_COMPACT = `export default ⟨0⟩(
  "Api",
  {
    main: import.meta.url,
    ⟨1⟩
  },
  Effect.gen(function* () {
    const bank = yield* CustomerApi;
    return { fetch: bank.fetch };
  }).pipe(Effect.provide(⟨2⟩)),
);

export class FraudReview extends
  AI.Process<FraudReview>()(
    "FraudReview",
    {
      description: "Review a withdrawal.",
    },
  )\`
    Read \${Bank.AccountSummary}. If it
    looks stolen, send
    \${Bank.FreezeAccount}.
  \` {}

export class Account extends
  Domain.Aggregate("Account", {
    decide: { WithdrawMoney },
    invariants: { NeverOverdrawn },
  }) {}`;

/** A host's values for the compact template. */
export const compactValues = (values: readonly string[]) => [
  values[0]!,
  values[1] ? `${values[1].replace(/^, /, "")},` : "",
  values[2]!,
];
