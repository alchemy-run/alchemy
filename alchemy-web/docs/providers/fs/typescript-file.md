# TypeScript File

The TypeScript File resource allows you to create and manage TypeScript files with formatted content using Prettier. This resource is part of the Alchemy Infrastructure-as-Code (IaC) library, which is designed to model resources that are created, updated, and deleted automatically. For more information on Alchemy, visit the [Alchemy GitHub repository](https://github.com/alchemy).

# Minimal Example

```ts
import { TypeScriptFile } from "alchemy/fs";

// Create a simple TypeScript file
const component = await TypeScriptFile("Component.ts", `
  interface Props {
    name: string;
    age: number;
  }

  export function Component({ name, age }: Props) {
    return <div>Hello {name}, you are {age} years old</div>;
  }
`);
```

# Create the TypeScript File

```ts
import { TypeScriptFile } from "alchemy/fs";

// Create a TypeScript file with a class definition
const userClass = await TypeScriptFile("User.ts", `
  class User {
    constructor(public name: string, public age: number) {}

    greet() {
      return \`Hello, my name is \${this.name} and I am \${this.age} years old.\`;
    }
  }

  export default User;
`);
```

This documentation provides a concise overview of how to use the TypeScript File resource in Alchemy to create and manage TypeScript files with formatted content.