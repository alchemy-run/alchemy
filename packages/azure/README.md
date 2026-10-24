# @alchemy.run/azure

Microsoft Azure for [Alchemy](https://alchemy.run). Declare resource groups, storage, identities, App Service, Front Door and about 1,190 other Azure Resource Manager resource types in the same TypeScript program as the code that uses them.

```sh
npm install alchemy @alchemy.run/azure effect
```

A Vite app on the static website endpoint of a storage account:

```typescript
// alchemy.run.ts
import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const web = yield* Azure.Website.Vite("Web", { location: "eastus" });
    return { url: web.url };
  }),
);
```

Authenticate with a Microsoft Entra service principal stored in an Alchemy profile (`alchemy profile edit --add Azure`), or set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_SUBSCRIPTION_ID`.

Docs: [alchemy.run/azure](https://alchemy.run/azure)
