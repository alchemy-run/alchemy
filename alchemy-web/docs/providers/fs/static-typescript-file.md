# StaticTypeScriptFile

Creates a TypeScript file with automatically formatted content using Prettier. The [StaticTypeScriptFile](https://github.com/alchemy/alchemy/blob/main/src/fs/static-typescript-file.ts) resource is part of Alchemy's file system utilities.

# Minimal Example

Create a basic TypeScript file with formatted content:

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const file = await StaticTypeScriptFile("hello.ts", `
  export function hello(name: string) {
    return "Hello " + name;
  }
`);
```

# With Custom Path

Create a TypeScript file at a specific path:

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const component = await StaticTypeScriptFile("components/Button.ts", 
  "./src/components/Button.ts",
  `
  interface ButtonProps {
    text: string;
    onClick: () => void;
  }

  export function Button({text, onClick}: ButtonProps) {
    return <button onClick={onClick}>{text}</button>;
  }
`);
```

# With Complex TypeScript Content

Create a TypeScript file with more complex content that will be automatically formatted:

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const api = await StaticTypeScriptFile("api.ts", `
  interface User {id: number; name: string; email: string}
  interface Post {id: number; title: string; content: string; authorId: number}

  export class API {
    async getUser(id: number): Promise<User> {
      const response = await fetch(\`/api/users/\${id}\`);
      return response.json();
    }

    async getPosts(userId: number): Promise<Post[]> {
      const response = await fetch(\`/api/users/\${userId}/posts\`);
      return response.json();
    }
  }
`);
```