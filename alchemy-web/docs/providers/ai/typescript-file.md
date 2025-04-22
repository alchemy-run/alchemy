# TypeScriptFile

The TypeScriptFile resource lets you generate TypeScript code files using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) or [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Generate a simple TypeScript utility function:

```ts
import { TypeScriptFile } from "alchemy/ai";

const utils = await TypeScriptFile("string-utils", {
  path: "./src/utils/string-utils.ts",
  prompt: "Generate TypeScript utility functions for string manipulation like capitalize, truncate, and camelCase"
});
```

# Generate Code with Context

Use alchemy template literals to include file context:

```ts
import { TypeScriptFile } from "alchemy/ai";

const service = await TypeScriptFile("user-service", {
  path: "./src/services/UserService.ts",
  prompt: await alchemy`
    Create a UserService class that handles user authentication.
    Use the User type from:
    ${alchemy.file("src/types/User.ts")}
  `,
  temperature: 0.2
});
```

# Custom Model and System Prompt

Configure the AI model and customize the system prompt:

```ts
import { TypeScriptFile } from "alchemy/ai";

const hook = await TypeScriptFile("use-form", {
  path: "./src/hooks/useForm.ts",
  prompt: "Create a React form hook with validation and submission handling",
  system: "You are an expert React developer. Create a single TypeScript file inside ```ts fences.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```