# TypeScriptFile

The TypeScriptFile resource generates TypeScript code files using AI models like OpenAI's GPT-4 or Anthropic's Claude. The generated code is automatically formatted with Prettier and saved to disk.

## Minimal Example

Create a simple TypeScript utility function:

```ts
import { TypeScriptFile } from "alchemy/ai";

const utils = await TypeScriptFile("string-utils", {
  path: "./src/utils/string-utils.ts",
  prompt: "Generate TypeScript utility functions for string manipulation (capitalize, truncate, camelCase, etc)"
});
```

## Generate Code with Context

Use alchemy template literals to include existing files as context:

```ts
import { TypeScriptFile } from "alchemy/ai";

const userService = await TypeScriptFile("user-service", {
  path: "./src/services/UserService.ts",
  prompt: await alchemy`
    Create a UserService class using these types:
    ${alchemy.file("src/types/User.ts")}
  `,
  temperature: 0.2
});
```

## Custom Formatting

Configure Prettier formatting options:

```ts
import { TypeScriptFile } from "alchemy/ai";

const component = await TypeScriptFile("component", {
  path: "./src/components/Button.tsx",
  prompt: "Generate a React button component with variants and sizes",
  prettierConfig: {
    semi: false,
    singleQuote: true,
    printWidth: 120
  }
});
```

## Custom System Prompt

Provide custom instructions to the AI model:

```ts
import { TypeScriptFile } from "alchemy/ai";

const hook = await TypeScriptFile("use-form", {
  path: "./src/hooks/useForm.ts", 
  prompt: "Create a form handling React hook with validation",
  system: "You are an expert React developer. Create a single TypeScript file with proper typing and React best practices.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```