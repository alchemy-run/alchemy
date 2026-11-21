# VM test of the module: one NixOS machine with local PostgreSQL and the
# pool `nixos-test`, deployed the way `ClusterNixOS.HostPool` deploys it
# (a store path in the profile, the environment in /var/lib, a restart).
#
# `fixture` is the directory the integration test writes without a host
# (packages/integration-tests/test/Cluster/NixOS.test.ts): runner.mjs with
# a greeter and a cron, and runner.env. Run on Linux with KVM:
#
#   CLUSTER_NIXOS_FIXTURE_DIR=$PWD/fixture bun alchemy-test test/Cluster/NixOS.test.ts
#   nix build -L --impure --expr '
#     let f = builtins.getFlake "path:'$PWD'/packages/effect-cluster/nix";
#         pkgs = f.inputs.nixpkgs.legacyPackages.x86_64-linux;
#     in f.lib.vmTest { inherit pkgs; fixture = '$PWD'/fixture; }'
{ fixture }:
{ pkgs, lib, ... }:
let
  runner =
    version:
    pkgs.runCommand "effect-cluster-nixos-test-${version}" { } ''
      mkdir -p $out
      cp ${fixture}/runner.mjs $out/runner.mjs
      echo ${version} > $out/VERSION
    '';
  v1 = runner "v1";
  v2 = runner "v2";
  profile = "/nix/var/nix/profiles/effect-cluster/nixos-test";
  unit = "effect-cluster-nixos-test.service";
in
{
  name = "effect-cluster-pool";

  nodes.host = {
    imports = [ ../module.nix ];
    services.effect-cluster.pools.nixos-test.database.createLocally = true;
    # The runners the test deploys, in the VM's store.
    system.extraDependencies = [
      v1
      v2
    ];
    environment.systemPackages = [ pkgs.curl ];
    virtualisation.memorySize = 2048;
  };

  testScript = ''
    import json

    def deploy(path):
        # What HostPool does over ssh, after `nix copy`.
        host.succeed("install -d -m 0700 /var/lib/effect-cluster/nixos-test")
        host.succeed("install -m 0600 ${fixture}/runner.env /var/lib/effect-cluster/nixos-test/runner.env")
        host.succeed("mkdir -p /nix/var/nix/profiles/effect-cluster")
        host.succeed(f"nix-env -p ${profile} --set {path}")
        host.succeed("systemctl restart ${unit}")

    def greet(name):
        body = json.dumps({
            "_tag": "Request", "id": "1", "tag": "Greeter.Greet",
            "payload": {"entityId": "vm", "payload": {"name": name}, "headers": {}},
            "headers": [],
        })
        return host.succeed(
            "set -a; . /var/lib/effect-cluster/nixos-test/runner.env; set +a; "
            + "curl -fsS -X POST -H \"Authorization: Bearer $CLUSTER_GATEWAY_TOKEN\" "
            + f"-H 'Content-Type: application/json' --data '{body}' http://127.0.0.1:34500/rpc"
        )

    host.wait_for_unit("postgresql.target")

    with subtest("no runner until the first deploy"):
        host.fail("systemctl is-active ${unit}")

    with subtest("deploy: the runner starts from the profile"):
        deploy("${v1}")
        host.wait_for_unit("${unit}")
        host.wait_until_succeeds("curl -fsS http://127.0.0.1:34500/health", timeout=120)

    with subtest("the gateway refuses a call without the token"):
        code = host.succeed("curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:34500/rpc").strip()
        assert code == "401", code

    with subtest("a command through the gateway"):
        out = greet("vm")
        assert "hello vm" in out, out

    with subtest("a cron runs"):
        host.wait_until_succeeds(
            "test $(journalctl -u ${unit} -o cat --no-pager | grep -c 'nixos-fixture tick') -ge 2",
            timeout=120,
        )

    with subtest("the runner restarts when it dies"):
        pid = host.succeed("systemctl show -p MainPID --value ${unit}").strip()
        host.succeed(f"kill -9 {pid}")
        host.wait_until_succeeds(f"test $(systemctl show -p MainPID --value ${unit}) != {pid}")
        host.wait_until_succeeds("curl -fsS http://127.0.0.1:34500/health", timeout=120)
        assert "hello again" in greet("again")

    with subtest("a new deploy is a new generation; rollback is the previous one"):
        deploy("${v2}")
        host.wait_until_succeeds("curl -fsS http://127.0.0.1:34500/health", timeout=120)
        assert host.succeed("cat ${profile}/VERSION").strip() == "v2"
        host.succeed("nix-env -p ${profile} --rollback")
        host.succeed("systemctl restart ${unit}")
        host.wait_until_succeeds("curl -fsS http://127.0.0.1:34500/health", timeout=120)
        assert host.succeed("cat ${profile}/VERSION").strip() == "v1"
        assert "hello back" in greet("back")

    with subtest("the ports stay closed in the firewall"):
        host.succeed("! iptables-save | grep -E 'dport (34431|34500)'")
  '';
}
