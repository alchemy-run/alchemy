---
title: Debugging
description: Debug your Alchemy projects with VSCode using breakpoints, step-through debugging, and inspector tools.
sidebar:
  order: 1
---

import { Steps } from '@astrojs/starlight/components';

Debug your Alchemy infrastructure and application code directly in VSCode with full breakpoint support and step-through debugging.

As part of this guide, we'll:
1. Install the required VSCode extensions for debugging
2. Configure VSCode tasks to run Alchemy with debugging enabled
3. Set up launch configurations to attach the debugger automatically

<Steps>

1. **Install VSCode Extensions**

   Install the [bun extension for VSCode](https://marketplace.visualstudio.com/items?itemName=oven.bun-vscode) and the [Command Variable extension](https://marketplace.visualstudio.com/items?itemName=rioj7.command-variable).

   :::tip
   Even if debugging node projects, you should use the bun extension. This is because the bun extension allows for more flexibility in how debuggers are connected.
   :::

2. **Configure VSCode Tasks**

   Create a file in `.vscode/tasks.json` with the following content:

   ```json
   {
     "version": "2.0.0",
     "tasks": [
       {
         "label": "alchemy-dev",
         "type": "shell",
         "command": "bun",
         "args": ["alchemy", "dev", "--inspect-wait"],
         "isBackground": true,
         "problemMatcher": {
           "pattern": {
             "regexp": "^$"
           },
           "background": {
             "activeOnStart": true,
             "beginsPattern": ".*",
             "endsPattern": "Waiting for inspector to connect.*"
           }
         }
       }
     ]
   }
   ```

   :::tip
   alchemy also supports `--inspect` and `--inspect-brk` flags. These flags are supported on `alchemy dev`, `alchemy deploy`, and `alchemy destroy`.
   :::

3. **Configure VSCode Launch**

   Create a file in `.vscode/launch.json` with the following content:

   ```json
   {
     "version": "0.2.0",
     "configurations": [
       {
         "name": "Debug Alchemy Dev",
         "type": "bun",
         "request": "attach",
         "url": "${input:debugUrl}",
         "stopOnEntry": false,
         "preLaunchTask": "alchemy-dev"
       },
     ],
     "inputs": [
       {
         "id": "debugUrl",
         "type": "command",
         "command": "extension.commandvariable.file.content",
         "args": {
           "fileName": "${workspaceFolder}/.alchemy/.debugger-urls",
           "key": "alchemy.run.ts",
         }
       }
     ]
   }
   ```
</Steps>