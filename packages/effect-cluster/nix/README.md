# Effect Cluster on NixOS

Run the runners of an `@alchemy.run/effect-cluster` pool as systemd services
on NixOS. There is no Docker, no package manager and no file in `/etc`:

- The host declares the service once, with the NixOS module in this
  directory.
- Each deploy puts the runner in the Nix store and points a Nix profile at
  it. Each deploy is a new profile generation.
- A rollback activates the previous generation.

## 1. Declare the pool on the host

Add the module to the host's NixOS configuration:

```nix
{
  inputs.effect-cluster.url = "github:alchemy-run/alchemy?dir=packages/effect-cluster/nix";

  outputs = { nixpkgs, effect-cluster, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        effect-cluster.nixosModules.default
        ./configuration.nix
        {
          services.effect-cluster.pools.orders = {
            runtime = nixpkgs.legacyPackages.x86_64-linux.nodejs_24;
            # PostgreSQL on this host: role and database `effect-cluster-orders`, peer auth.
            database.createLocally = true;
          };
        }
      ];
    };
  };
}
```

This makes the unit `effect-cluster-orders.service`. It does not start
until the first deploy. Options, per pool:

| Option | Default | Use |
| --- | --- | --- |
| `package` | `null` | A store path with `runner.mjs`. Null: the runner comes from the profile `/nix/var/nix/profiles/effect-cluster/<name>`. |
| `runtime` | `pkgs.nodejs` | Node.js or Bun. |
| `environmentFile` | `/var/lib/effect-cluster/<name>/runner.env` | Database URL, gateway token, shard groups. Never in the store. |
| `environment` | `{}` | More variables. `environmentFile` overrides them. |
| `listenAddress`, `runnerAddress` | `127.0.0.1` | Set a private address when the pool has runners on more than one host. |
| `runnerPort`, `gatewayPort` | `34431`, `34500` | Other values need a runner that reads `CLUSTER_RUNNER_PORT` / `CLUSTER_GATEWAY_PORT`. |
| `gatewayListenAddress` | runner default | `CLUSTER_GATEWAY_LISTEN_HOST`. |
| `openFirewall` | `false` | Open `runnerPort` and `gatewayPort`. |
| `user` | `effect-cluster-<name>` | The runner's system user, at most 31 characters. |
| `database.createLocally` | `false` | Local PostgreSQL with a role and database named `user`. |

The unit runs with `Restart=always` and a strict sandbox
(`ProtectSystem=strict`, no capabilities, `@system-service` system calls).

## 2. Deploy with `ClusterNixOS.HostPool`

```ts
import * as Cluster from "@alchemy.run/effect-cluster";
import * as ClusterNixOS from "@alchemy.run/effect-cluster/NixOS";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Database = Cluster.Database.fromUrl({
  url: Redacted.make(
    "postgres://effect-cluster-orders@localhost/effect-cluster-orders?host=/run/postgresql",
  ),
});

export const Default = ClusterNixOS.HostPool("Default", {
  name: "orders", // services.effect-cluster.pools.orders
  host: "root@203.0.113.7",
}).pipe(Layer.provide(Database));
```

Give the pool to entities as with any other pool (`layerEntities({ pool })`
does not change). On each deploy, `HostPool`:

1. bundles the runner (`runner.mjs`) and adds it to the local store
   (`nix-store --add`),
2. copies it to the host (`nix copy --to ssh-ng://<host>`),
3. writes the runner's environment to `environmentFile` (mode 0600, sent
   over stdin, never in argv or the store),
4. runs `nix-env -p /nix/var/nix/profiles/effect-cluster/<name> --set <path>`
   and restarts the unit.

The machine that deploys needs `nix` and `ssh`. The ssh user must be root,
or a Nix trusted user with `sudo` (`sudo: true`).

## 3. Roll back

On the host:

```sh
nix-env -p /nix/var/nix/profiles/effect-cluster/orders --list-generations
nix-env -p /nix/var/nix/profiles/effect-cluster/orders --rollback
systemctl restart effect-cluster-orders.service
```

The environment file is not versioned: a rollback keeps the current
database URL and token.

## Without HostPool

To deploy with `nixos-rebuild` only, write the runner with
`ClusterProcess.ProcessPool` (it writes `runner.mjs` and `runner.env` to a
directory), then set `package` to a derivation that holds that
`runner.mjs` and put `runner.env` at `environmentFile` with your secret
tool (agenix, sops-nix). Rollback is then the previous NixOS generation:
`nixos-rebuild switch --rollback`.

## Tests

- `nix flake check` evaluates the module and renders its units (no VM).
- `tests/vm.nix` boots a NixOS VM with PostgreSQL, deploys the runner as
  `HostPool` does, and checks a command through the gateway, a cron, a
  restart after `kill -9`, a new generation and a rollback. It needs Linux
  with KVM; see the file for the command.
