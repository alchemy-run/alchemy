{
  description = "Run Effect Cluster runners from @alchemy.run/effect-cluster on NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      nixosModules.default = ./module.nix;
      nixosModules.effect-cluster = ./module.nix;

      lib = {
        /**
          The VM test: a NixOS machine with the module, local PostgreSQL, and
          a runner that serves one command and one cron. `fixture` is the
          directory `bun scripts/nixos-fixture.ts` writes (runner.mjs and
          runner.env). Needs a Linux builder with KVM.
        */
        vmTest = { pkgs, fixture }: pkgs.testers.runNixOSTest (import ./tests/vm.nix { inherit fixture; });
      };

      checks = forAll (pkgs: {
        # The module evaluates, and its unit renders, with a runner from the
        # profile and from a package. Builds no VM.
        module =
          let
            eval = nixpkgs.lib.nixosSystem {
              inherit (pkgs.stdenv.hostPlatform) system;
              modules = [
                self.nixosModules.default
                {
                  boot.loader.grub.enable = false;
                  fileSystems."/" = {
                    device = "/dev/null";
                    fsType = "ext4";
                  };
                  system.stateVersion = "26.05";
                  services.effect-cluster.pools = {
                    default.database.createLocally = true;
                    fixed = {
                      package = pkgs.writeTextDir "runner.mjs" "";
                      runtime = pkgs.bun;
                      openFirewall = true;
                    };
                  };
                }
              ];
            };
            units = eval.config.systemd.units;
          in
          pkgs.runCommand "effect-cluster-module-check" { } ''
            grep -q 'ExecStart=.*/bin/node /nix/var/nix/profiles/effect-cluster/default/runner.mjs' \
              ${units."effect-cluster-default.service".unit}/effect-cluster-default.service
            grep -q 'ExecStart=.*/bin/bun /nix/store/.*/runner.mjs' \
              ${units."effect-cluster-fixed.service".unit}/effect-cluster-fixed.service
            grep -q 'EnvironmentFile=/var/lib/effect-cluster/default/runner.env' \
              ${units."effect-cluster-default.service".unit}/effect-cluster-default.service
            touch $out
          '';
      });
    };
}
