/**
 * The hero's provider reel: one model, declared and proved once, hosted on
 * seven clouds. Durable Objects host it on Cloudflare; elsewhere Rivet or
 * Effect Cluster do, on a pool of that cloud's compute. The bank is the model
 * the rest of the page uses.
 *
 * ⟨0⟩ is the Layer that hosts the model, and ⟨1⟩ its options: `bank` is the
 * name and entry file every pool-backed host takes.
 */
export const HOST_TEMPLATE = `const BankLive = Layer.provide(
  Bank.layer(BankHandlers),
  ⟨0⟩(
    ⟨1⟩,
  ),
);

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
  values: [string, string];
  resources: HostResource[];
  url?: string;
}

const RIVET = "DomainRivet.layerDurableObjects";
const CLUSTER = "DomainCluster.layerEntities";
const pool = (p: string) => `{ ...bank, pool: ${p}("Default") }`;
const rivet = (api: string): HostResource[] => [
  { id: "Bank", type: "Rivet.Namespace" },
  { id: "Default", type: "Rivet.Pool" },
  { id: "Api", type: api },
];
const cluster = (api: string): HostResource[] => [
  { id: "Shards", type: "Cluster.ShardGroups" },
  { id: "Default", type: "Cluster.Pool" },
  { id: "Api", type: api },
];

export const HOSTS: Host[] = [
  {
    label: "Cloudflare",
    values: ["DomainCloudflare.layerDurableObjects", '{ jurisdiction: "eu" }'],
    resources: [
      { id: "Ledger", type: "Cloudflare.D1Database" },
      { id: "Bank", type: "Cloudflare.DurableObject" },
      { id: "Api", type: "Cloudflare.Worker" },
    ],
    url: "https://api.bank.workers.dev",
  },
  {
    label: "AWS",
    values: [RIVET, pool("RivetAWS.EcsPool")],
    resources: rivet("AWS.Lambda.Function"),
    url: "https://7xk2q.lambda-url.us-east-1.on.aws",
  },
  {
    label: "GCP",
    values: [RIVET, pool("RivetGCP.CloudRunPool")],
    resources: rivet("GCP.Run.Service"),
    url: "https://api-7xk2q-uc.a.run.app",
  },
  {
    label: "Kubernetes",
    values: [CLUSTER, pool("ClusterKubernetes.DeploymentPool")],
    resources: cluster("Kubernetes.Deployment"),
  },
  {
    label: "Fly",
    values: [RIVET, pool("RivetFly.MachinePool")],
    resources: rivet("Fly.Service"),
    url: "https://bank-api.fly.dev",
  },
  {
    label: "Railway",
    values: [RIVET, pool("RivetRailway.ServicePool")],
    resources: rivet("Railway.Service"),
    url: "https://api-production.up.railway.app",
  },
  {
    label: "Hetzner",
    values: [RIVET, pool("RivetHetzner.ServerPool")],
    resources: rivet("Hetzner.Service"),
  },
  {
    label: "Docker",
    values: [CLUSTER, pool("ClusterDocker.SwarmPool")],
    resources: cluster("Docker.Service"),
  },
];

/** The template with one host's values filled in. */
export const hostSource = (values: readonly string[]) =>
  HOST_TEMPLATE.replace(/⟨(\d)⟩/g, (_, i: string) => values[+i]!);

/**
 * The same program for narrow screens: the handlers are folded to their
 * names and the pool to its bare constructor, so no line passes ~42 columns.
 */
export const HOST_TEMPLATE_COMPACT = `const BankLive = Layer.provide(
  Bank.layer(BankHandlers),
  ⟨0⟩({
    ⟨1⟩,
  }),
);

export class Account extends
  Domain.Aggregate("Account", {
    decide: { WithdrawMoney },
    invariants: { NeverOverdrawn },
  }) {}`;

/** A host's values for the compact template. */
export const compactValues = (values: readonly string[]) => [
  values[0]!,
  values[1]!.replace(/^\{ (?:\.\.\.bank, )?(.*) \}$/, "$1").replace(/pool: \w+\./, "pool: "),
];
