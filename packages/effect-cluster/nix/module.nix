# Run Effect Cluster runners from `@alchemy.run/effect-cluster` as systemd
# services on NixOS. No Docker, no package manager, no files in /etc.
#
# Each attribute of `services.effect-cluster.pools` is one pool's runner on
# this host, the unit `effect-cluster-<name>.service`. The runner program
# comes from one of two places:
#
# - `package` set: a store path that holds `runner.mjs`. `nixos-rebuild`
#   deploys it; rollback is the previous NixOS generation.
# - `package = null` (the default): the Nix profile
#   `/nix/var/nix/profiles/effect-cluster/<name>`, which
#   `ClusterNixOS.HostPool` sets on each deploy. Rollback is the previous
#   profile generation.
#
# Secrets (the database URL, the gateway token) never go into the store:
# the runner reads them from `environmentFile`.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkOption types;
  cfg = config.services.effect-cluster;
  profiles = "/nix/var/nix/profiles/effect-cluster";

  poolModule =
    { name, config, ... }:
    {
      options = {
        package = mkOption {
          type = types.nullOr types.package;
          default = null;
          description = ''
            A store path that holds the pool's `runner.mjs`. When null, the
            runner comes from the profile `${profiles}/<name>`, which
            `ClusterNixOS.HostPool` sets.
          '';
        };

        runtime = mkOption {
          type = types.package;
          default = pkgs.nodejs;
          defaultText = lib.literalExpression "pkgs.nodejs";
          example = lib.literalExpression "pkgs.bun";
          description = "The JavaScript runtime that runs `runner.mjs` (Node.js or Bun).";
        };

        environmentFile = mkOption {
          type = types.str;
          default = "/var/lib/effect-cluster/${name}/runner.env";
          description = ''
            The runner's environment, one `KEY="value"` per line: the
            database URL, the gateway token, the shard groups and the stack
            values. `ClusterNixOS.HostPool` writes it on each deploy (mode
            0600). It must not be in the Nix store.
          '';
        };

        environment = mkOption {
          type = types.attrsOf types.str;
          default = { };
          description = "More environment for the runner. `environmentFile` overrides it.";
        };

        listenAddress = mkOption {
          type = types.str;
          default = "127.0.0.1";
          description = ''
            The address the runner listens on for other runners
            (`CLUSTER_LISTEN_HOST`). Set a private address when the pool has
            runners on more than one host.
          '';
        };

        runnerAddress = mkOption {
          type = types.str;
          default = "127.0.0.1";
          description = ''
            The address other runners reach this runner at, as it registers
            it in the database (`CLUSTER_RUNNER_HOST`).
          '';
        };

        runnerPort = mkOption {
          type = types.port;
          default = 34431;
          description = ''
            The runner's port (`CLUSTER_RUNNER_PORT`). A value other than the
            default needs a runner that reads it from its environment.
          '';
        };

        gatewayPort = mkOption {
          type = types.port;
          default = 34500;
          description = ''
            The gateway's port (`CLUSTER_GATEWAY_PORT`). A value other than
            the default needs a runner that reads it from its environment.
          '';
        };

        gatewayListenAddress = mkOption {
          type = types.nullOr types.str;
          default = null;
          example = "127.0.0.1";
          description = ''
            The gateway's listen address (`CLUSTER_GATEWAY_LISTEN_HOST`).
            Null keeps the runner's default (every address). The firewall
            stays closed unless `openFirewall` is set.
          '';
        };

        openFirewall = mkOption {
          type = types.bool;
          default = false;
          description = "Open `runnerPort` and `gatewayPort` in the firewall.";
        };

        user = mkOption {
          type = types.str;
          default = "effect-cluster-${name}";
          description = "The system user the runner runs as. Created when it does not exist.";
        };

        database.createLocally = mkOption {
          type = types.bool;
          default = false;
          description = ''
            Run PostgreSQL on this host with a role and a database named
            `user`, which the runner reaches over the Unix socket with peer
            authentication (no password). Point the pool's database at
            `postgres://<user>@localhost/<user>?host=/run/postgresql`.
          '';
        };

        profile = mkOption {
          type = types.str;
          readOnly = true;
          default = "${profiles}/${name}";
          description = "The profile the runner comes from when `package` is null.";
        };
      };
    };

  unitName = name: "effect-cluster-${name}";

  runnerDir = pool: if pool.package == null then pool.profile else "${pool.package}";

  service =
    name: pool:
    lib.nameValuePair (unitName name) {
      description = "Effect Cluster runner of pool ${name}";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
      ]
      ++ lib.optional pool.database.createLocally "postgresql.target";
      # `postgresql.target` is up once the role and database exist.
      requires = lib.optional pool.database.createLocally "postgresql.target";
      # Until the first deploy sets the profile, there is nothing to run.
      unitConfig.ConditionPathExists = "${runnerDir pool}/runner.mjs";
      # `Restart=always` means always: never give up after a burst of failures.
      startLimitIntervalSec = 0;
      environment = {
        NODE_ENV = "production";
        CLUSTER_LISTEN_HOST = pool.listenAddress;
        CLUSTER_RUNNER_HOST = pool.runnerAddress;
        CLUSTER_RUNNER_PORT = toString pool.runnerPort;
        CLUSTER_GATEWAY_PORT = toString pool.gatewayPort;
      }
      // lib.optionalAttrs (pool.gatewayListenAddress != null) {
        CLUSTER_GATEWAY_LISTEN_HOST = pool.gatewayListenAddress;
      }
      // pool.environment;
      serviceConfig = {
        ExecStart = "${lib.getExe pool.runtime} ${runnerDir pool}/runner.mjs";
        EnvironmentFile = pool.environmentFile;
        User = pool.user;
        Group = pool.user;
        Restart = "always";
        RestartSec = 1;
        # Effect Cluster hands shards over on SIGTERM.
        KillSignal = "SIGTERM";
        TimeoutStopSec = 30;
        LimitNOFILE = 65536;

        # Sandbox: the runner reads its program and talks to the network.
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateIPC = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        RemoveIPC = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        SystemCallErrorNumber = "EPERM";
      };
    };

  pools = lib.attrValues (lib.mapAttrs (name: pool: pool // { inherit name; }) cfg.pools);
  local = lib.filter (pool: pool.database.createLocally) pools;
in
{
  options.services.effect-cluster.pools = mkOption {
    type = types.attrsOf (types.submodule poolModule);
    default = { };
    example = lib.literalExpression ''
      {
        default = {
          runtime = pkgs.nodejs_24;
          database.createLocally = true;
        };
      }
    '';
    description = ''
      Effect Cluster pools whose runners run on this host, by pool name: the
      `name` of the `ClusterNixOS.HostPool` that deploys them.
    '';
  };

  config = lib.mkIf (cfg.pools != { }) {
    assertions = map (pool: {
      assertion = builtins.stringLength pool.user <= 31;
      message = "services.effect-cluster.pools.${pool.name}.user: '${pool.user}' is longer than 31 characters; set a shorter `user`.";
    }) pools;

    users.users = lib.listToAttrs (
      map (
        pool:
        lib.nameValuePair pool.user {
          isSystemUser = true;
          group = pool.user;
        }
      ) pools
    );
    users.groups = lib.listToAttrs (map (pool: lib.nameValuePair pool.user { }) pools);

    systemd.services = lib.mapAttrs' service cfg.pools;

    # The profiles `HostPool` sets, readable by every runner's user, and the
    # directories it writes each environment to, readable by root only.
    systemd.tmpfiles.rules = [ "d ${profiles} 0755 root root -" ] ++ map (
      pool: "d ${builtins.dirOf pool.environmentFile} 0700 root root -"
    ) (lib.filter (pool: lib.hasPrefix "/var/lib/effect-cluster/" pool.environmentFile) pools);

    networking.firewall.allowedTCPPorts = lib.concatMap (
      pool:
      lib.optionals pool.openFirewall [
        pool.runnerPort
        pool.gatewayPort
      ]
    ) pools;

    services.postgresql = lib.mkIf (local != [ ]) {
      enable = true;
      ensureDatabases = map (pool: pool.user) local;
      ensureUsers = map (pool: {
        name = pool.user;
        ensureDBOwnership = true;
      }) local;
    };
  };
}
