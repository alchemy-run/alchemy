# @alchemy.run/archil

Archil for [Alchemy](https://alchemy.run). Durable disks that mount in about 100 ms, serverless exec against a disk, branches and checkpoints, and Firecracker sandboxes, declared in the same TypeScript program as the code that uses them.

```sh
npm install alchemy @alchemy.run/archil @alchemy.run/cloudflare effect
```

A disk per user, created at run time from a Cloudflare Worker:

```typescript
// src/Api.ts
import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const disks = yield* Archil.CreateDisk();
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const user = request.headers["x-user"] ?? "anonymous";
        const home = yield* disks.create(`user-${user}`);
        const result = yield* home.exec("ls -la /mnt/archil");
        return HttpServerResponse.text(result.stdout);
      }),
    };
  }).pipe(Effect.provide(Archil.CreateDiskHttp)),
) {}
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "Disks",
  { providers: Layer.mergeAll(Archil.providers(), Cloudflare.providers()) },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

Docs: [alchemy.run/archil](https://alchemy.run/archil) · [All pages](https://alchemy.run/llms.txt)
