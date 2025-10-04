---
title: Workspace
description: Resolve Prisma Postgres workspace metadata for use with other resources.
---

Use the `Workspace` resource to retrieve workspace details with either the workspace id or name. This is useful when you need to display metadata or verify that a service token has access to the expected workspace.

## Lookup by ID

```ts
import { Workspace } from "alchemy/prisma/postgres";

const workspace = await Workspace("workspace", {
  id: "wksp_cmg94yrap00a9xgfncx1mwt34",
});
```

## Lookup by Name

```ts
import { Workspace } from "alchemy/prisma/postgres";

const workspace = await Workspace("workspace", {
  name: "Production",
});
```

## Custom Service Token

```ts
import { Workspace } from "alchemy/prisma/postgres";

const workspace = await Workspace("workspace", {
  id: "wksp_cmg94yrap00a9xgfncx1mwt34",
  serviceToken: alchemy.secret(process.env.PRISMA_SERVICE_TOKEN),
});
```
