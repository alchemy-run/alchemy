# @alchemy.run/stackit

[STACKIT](https://www.stackit.de) for [Alchemy](https://alchemy.run). Declare projects, networks, DNS, object storage and service enablement on Schwarz Group's sovereign German cloud, all in one TypeScript program.

```sh
npm install alchemy @alchemy.run/stackit effect
```

Enable a STACKIT service for the project in your profile:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Stackit.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const ske = yield* Stackit.ServiceEnablement.Service("Ske", {
      serviceId: "cloud.stackit.ske",
    });
    return { state: ske.state };
  }),
);
```

Authenticate with a service-account key:

```sh
alchemy profile edit --add Stackit
```

See [STACKIT setup](https://alchemy.run/stackit/setup) and the [STACKIT overview](https://alchemy.run/stackit).
