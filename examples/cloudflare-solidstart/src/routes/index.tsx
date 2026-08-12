import { Title } from "@solidjs/meta";
import Counter from "~/components/Counter";

export default function Home() {
  return (
    <main class="mx-auto p-4 text-center">
      <Title>Hello World</Title>
      <h1 class="my-16 text-3xl font-bold uppercase text-sky-800">
        Hello world!
      </h1>
      <Counter />
      <p class="mx-auto my-8 max-w-prose leading-snug">
        Visit{" "}
        <a
          class="text-sky-700 underline"
          href="https://start.solidjs.com"
          target="_blank"
        >
          start.solidjs.com
        </a>{" "}
        to learn how to build SolidStart apps.
      </p>
    </main>
  );
}
