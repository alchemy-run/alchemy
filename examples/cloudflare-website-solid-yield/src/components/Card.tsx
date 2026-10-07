import { component, view, type Props } from "solid-yield";

// A yield component styled with Tailwind utility classes.
export const Card = component(function* Card(props: Props<{ title: string; body: string }>) {
  return view(function* () {
    return (
      <section class="mt-6 max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-lg font-semibold">{yield* props.title}</h2>
        <p class="mt-2 text-slate-600">{yield* props.body}</p>
      </section>
    );
  });
});
