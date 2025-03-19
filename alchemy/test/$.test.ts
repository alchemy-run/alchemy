import { test } from "bun:test";
import { $, type Output } from "../src";

test("$ types", () => {
  // no-op
});

declare const name: Output<string>;

function hello(name?: string, ...names: number[]): string {
  return `hello ${name}`;
}

class Foo {
  hello(name?: string, ...names: number[]): string {
    return `hello ${name}`;
  }
}

// place in closure so it never actually runs
function _() {
  // @ts-expect-error - Argument of type 'Output<string>' is not assignable to parameter of type 'string'.ts(2345)
  hello(name);

  // must instead wrap in $ to proxy Outputs into the function
  const message: Output<string> = $(hello)(name);

  const logged: Output<void> = $(console).log(message);

  const foo = new Foo();
  // @ts-expect-error - can't pass Output<string> to a string
  foo.hello(name);

  // fix with $
  $(foo).hello(name);
  $(foo).hello();
  $(foo).hello(
    name,
    /*
    Argument of type 'Output<string>' is not assignable to parameter of type 'Input<number>'.
      Type 'Output<string>' is not assignable to type 'Output<number>'.
        Type 'string' is not assignable to type 'number'.
    */
    // @ts-expect-error
    name,
  );
}
