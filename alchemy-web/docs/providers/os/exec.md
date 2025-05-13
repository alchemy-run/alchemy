---
title: Executing OS Commands with Alchemy
description: Learn how to run operating system commands during your Alchemy deployments using the OS Exec provider.
---

# Exec

The Exec resource allows you to execute shell commands as part of your Alchemy infrastructure. It provides a way to run system commands with full control over the execution environment and output handling.

## Minimal Example

Execute a simple shell command:

```ts
import { Exec } from "alchemy/os";

const result = await Exec("list-files", {
  command: "ls -la"
});

console.log(result.stdout);
```

## Working Directory and Environment

Run a command in a specific directory with custom environment variables:

```ts
import { Exec } from "alchemy/os";

const build = await Exec("build-project", {
  command: "npm run build",
  cwd: "./my-project",
  env: { 
    NODE_ENV: "production"
  }
});
```

## Command Memoization 

Cache command output and only re-run when the command changes:

```ts
import { Exec } from "alchemy/os";

const status = await Exec("git-status", {
  command: "git status",
  memoize: true
});
```

## Custom Buffer Size

Handle large command output by increasing the buffer size:

```ts
import { Exec } from "alchemy/os";

const logs = await Exec("get-logs", {
  command: "cat large-log-file.log", 
  maxBuffer: 10 * 1024 * 1024 // 10MB
});
```