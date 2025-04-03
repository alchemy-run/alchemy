# Static TypeScript File

The Static TypeScript File resource allows you to create a TypeScript file with formatted content using [Prettier](https://prettier.io/).

# Minimal Example

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

const component = await StaticTypeScriptFile("Component.ts", `
  interface Props {
    name: string;
    age: number;
  }

  export function Component({ name, age }: Props) {
    return <div>Hello {name}, you are {age} years old</div>;
  }
`);
```

# Create the Static TypeScript File

```ts
import { StaticTypeScriptFile } from "alchemy/fs";

// Create a TypeScript file with a simple function
const utils = await StaticTypeScriptFile("utils.ts", `
  export function add(a: number, b: number): number {
    return a + b;
  }
`);

// Create a TypeScript file with an interface and a class
const model = await StaticTypeScriptFile("model.ts", `
  interface User {
    id: string;
    name: string;
  }

  export class UserModel {
    private users: User[] = [];

    addUser(user: User) {
      this.users.push(user);
    }

    getUser(id: string): User | undefined {
      return this.users.find(user => user.id === id);
    }
  }
`);
```