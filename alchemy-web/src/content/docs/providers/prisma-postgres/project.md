---
title: Project
description: Create or adopt Prisma Postgres projects within a workspace.
---

`Project` provisions Prisma Postgres projects and optionally creates the default database. Service tokens scoped to the workspace must be supplied via `PRISMA_SERVICE_TOKEN` or the `serviceToken` prop.

## Minimal Project

Create a project without provisioning the default database:

```ts
import { Project } from "alchemy/prisma/postgres";

const project = await Project("app-project", {
  name: "app-project",
  region: "us-east-1",
  createDatabase: false,
});
```

## Adopt Existing Project

Reuse a project if it already exists in the workspace by leaving the default `adopt: true` behaviour:

```ts
import { Project } from "alchemy/prisma/postgres";

const project = await Project("existing", {
  name: "existing",
  region: "us-east-1",
});
```

## Force New Project Creation

Disable adoption to ensure a fresh project is created:

```ts
import { Project } from "alchemy/prisma/postgres";

const project = await Project("fresh", {
  name: "fresh-project",
  region: "eu-central-1",
  createDatabase: false,
  adopt: false,
});
```

## Custom Service Token

```ts
import { Project } from "alchemy/prisma/postgres";

const project = await Project("project", {
  name: "per-region",
  region: "ap-southeast-1",
  createDatabase: false,
  serviceToken: alchemy.secret(process.env.PRISMA_PROJECT_TOKEN),
});
```
