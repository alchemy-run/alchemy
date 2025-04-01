# TypeScript File

The TypeScript File resource allows you to create and manage TypeScript files with formatted content using [Prettier](https://prettier.io/).

# Minimal Example

```ts
import { TypeScriptFile } from "alchemy/fs";

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

const service = await TypeScriptFile("Service.ts", `
  export class Service {
    constructor(private name: string) {}

    getName() {
      return this.name;
    }
  }
`);
```