import * as Ssh from "@/Ssh";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const repo = [
  "set -e",
  "git init -q --bare /srv/repo.git",
  "work=$(mktemp -d)",
  'git -C "$work" init -q',
  'git -C "$work" -c user.name=alchemy -c user.email=alchemy@example.com commit -q --allow-empty -m init',
  'git -C "$work" tag v1',
  'git -C "$work" push -q /srv/repo.git v1',
].join("\n");

export const Sandbox = Ssh.make({
  main: import.meta.url,
  name: "sandbox",
  vars: Schema.Struct({
    greeting: Schema.String,
    token: Schema.Redacted(Schema.String),
    publicKey: Schema.String,
  }),
  handlers: {
    greeted: Ssh.Steps.exec({
      command: "date >> /srv/app/greeted",
      sudo: true,
    }),
  },
  run: (vars) =>
    Effect.gen(function* () {
      const { pkgManager } = yield* Ssh.facts;
      yield* Ssh.Steps.package({
        packages: pkgManager === "apt" ? ["git", "ufw"] : ["git"],
      });
      yield* Ssh.Steps.directory({
        path: "/srv/app",
        owner: "alchemy",
        mode: "0755",
        sudo: true,
      });
      yield* Ssh.Steps.file({
        path: "/srv/app/greeting",
        content: `${vars.greeting}\n`,
        mode: "0644",
        sudo: true,
        notify: ["greeted"],
      });
      yield* Ssh.Steps.file({
        path: "/srv/app/token",
        content: Redacted.value(vars.token),
        mode: "0600",
        atomic: true,
        sudo: true,
      });
      yield* Ssh.Steps.managedBlock({
        path: "/srv/app/app.conf",
        block: `token=${Redacted.value(vars.token)}`,
        commentPrefix: "#",
        create: true,
        sudo: true,
      });
      yield* Ssh.Steps.exec({
        name: "seed repo",
        command: repo,
        creates: "/srv/repo.git",
        sudo: true,
      });
      yield* Ssh.Steps.git({
        repo: "/srv/repo.git",
        dest: "/srv/checkout",
        version: "v1",
        sudo: true,
      });
      yield* Ssh.Steps.authorizedKey({ key: vars.publicKey });
      yield* Ssh.Steps.stamp({
        name: "greeting",
        path: "/srv/app/.greeting-stamp",
        value: vars.greeting,
        command: "true",
        sudo: true,
      });
      yield* Ssh.Steps.waitFor({
        name: "greeting",
        command: "test -s /srv/app/greeting",
        timeout: "10 seconds",
        interval: "1 second",
      });
      if (pkgManager === "apt") {
        // No iptables in a container, so the firewall stays disabled; the
        // defaults and rules still land in ufw's config.
        yield* Ssh.Steps.ufw({
          defaults: { incoming: "deny" },
          rules: ["limit ssh", "allow 443/tcp"],
          enabled: false,
        });
      }
    }),
});
