/**
 * The hero's platform reel: one model, declared and proved once, grounded in
 * three actor platforms by swapping one Layer. The bank is the model the rest
 * of the page uses.
 *
 * ⟨0⟩ is the Layer that hosts the model on that platform.
 */
export const HOST_TEMPLATE = `export class Account extends Domain.Aggregate("Account", {
  decide: {
    WithdrawMoney: (account, { amount }) =>
      amount > account.balance
        ? new InsufficientFunds()
        : [new MoneyWithdrawn({ amount })],
  },
  invariants: {
    NeverOverdrawn: ({ balance }) => balance >= 0,
  },
}) {}

const BankLive = Layer.provide(
  Bank.layer(BankHandlers),
  ⟨0⟩,
);`;

export interface HostResource {
  id: string;
  type: string;
  bindings?: string[];
}

export interface Host {
  /** Reel label: the platform. */
  label: string;
  values: [string];
  resources: HostResource[];
  url?: string;
}

export const HOSTS: Host[] = [
  {
    label: "Durable Objects",
    values: ["DomainCloudflare.layerDurableObjects()"],
    resources: [
      { id: "Ledger", type: "Cloudflare.D1Database" },
      { id: "Bank", type: "Cloudflare.DurableObject" },
      { id: "Api", type: "Cloudflare.Worker" },
    ],
    url: "https://api.bank.workers.dev",
  },
  {
    label: "Rivet",
    values: ["DomainRivet.layerDurableObjects(rivet)"],
    resources: [
      { id: "Bank", type: "Rivet.Namespace" },
      { id: "Default", type: "Rivet.Pool" },
      { id: "Api", type: "Cloudflare.Worker" },
    ],
    url: "https://api.bank.workers.dev",
  },
  {
    label: "Effect Cluster",
    values: ["DomainCluster.layerEntities(cluster)"],
    resources: [
      { id: "Shards", type: "Cluster.ShardGroups" },
      { id: "Default", type: "Cluster.Pool" },
      { id: "Api", type: "Docker.Service" },
    ],
  },
];

/** The template with one host's values filled in. */
export const hostSource = (values: readonly string[]) =>
  HOST_TEMPLATE.replace(/⟨(\d)⟩/g, (_, i: string) => values[+i]!);

/**
 * The same program for narrow screens: the handlers are folded to their
 * names, so no line passes ~42 columns.
 */
export const HOST_TEMPLATE_COMPACT = `export class Account extends
  Domain.Aggregate("Account", {
    decide: { WithdrawMoney },
    invariants: { NeverOverdrawn },
  }) {}

const BankLive = Layer.provide(
  Bank.layer(BankHandlers),
  ⟨0⟩,
);`;

/** A host's values for the compact template. */
export const compactValues = (values: readonly string[]) => values;
