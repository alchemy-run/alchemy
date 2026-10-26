# @alchemy.run/digitalocean

DigitalOcean for [Alchemy](https://alchemy.run). Declare Droplets, SSH keys and Cloud Firewalls in one typed Effect program, next to the rest of your stack.

```sh
npm install alchemy @alchemy.run/digitalocean effect
```

A Droplet reachable over SSH on a key minted in the stack, with a firewall that admits only SSH and HTTPS:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: DigitalOcean.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const key = yield* Alchemy.KeyPair("deploy-key", { algorithm: "ed25519" });
    const sshKey = yield* DigitalOcean.SshKey("deploy-key", {
      publicKey: key.publicKey,
    });
    const host = yield* DigitalOcean.Droplet("app", {
      region: "sfo3",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      sshKeys: [sshKey.fingerprint],
      tags: ["app"],
    });
    yield* DigitalOcean.Firewall("app", {
      tags: ["app"],
      inboundRules: [
        { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] },
        { protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] },
      ],
    });
    return { ip: host.ipv4 };
  }),
);
```

`alchemy deploy` registers the key, creates the Droplet and attaches the firewall by tag. Only `name` and `tags` change in place; a new region, size or image replaces the Droplet, so provision it with `userData` (cloud-init).

## Learn more

- [DigitalOcean on alchemy.run](https://alchemy.run/digitalocean)
- [Setup](https://alchemy.run/digitalocean/setup)
- [API reference](https://alchemy.run/providers)
