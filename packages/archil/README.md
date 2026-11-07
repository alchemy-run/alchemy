# @alchemy.run/archil

[Archil](https://archil.com) for [Alchemy](https://alchemy.run). Durable disks that mount in about 100 ms, serverless exec against a disk, branches and checkpoints, and Firecracker sandboxes that run your programs, declared in the same TypeScript program as the code that uses them.

```sh
npm install alchemy @alchemy.run/archil effect
```

A disk, and a sandbox that runs a program with the disk mounted. Its port gets a public URL, and a request to a paused sandbox starts it again:

```typescript
// src/Api.ts
import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Dataset = Archil.Disk("Dataset", {});

export default class Api extends Archil.Sandbox<Api>()(
  "Api",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const dataset = yield* Archil.MountDisk(Dataset, { path: "/data" });
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* fs.readDirectory(dataset.path));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Archil.MountDiskLive)),
) {}
```

```typescript
// alchemy.run.ts
import * as Archil from "@alchemy.run/archil";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "Disks",
  { providers: Archil.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

For a disk per user, bind `Archil.CreateDisk()` in a Worker or Lambda, and run commands against the disk without a sandbox:

```typescript
const disks = yield* Archil.CreateDisk();

// per request
const home = yield* disks.create(`user-${user}`);
const result = yield* home.exec("ls -la /mnt/archil");
```

Docs: [alchemy.run/archil](https://alchemy.run/archil) · [All pages](https://alchemy.run/llms.txt)
