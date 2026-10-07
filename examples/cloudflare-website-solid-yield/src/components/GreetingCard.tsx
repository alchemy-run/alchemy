import { component, view, type Props, type Source } from "solid-yield";
import type { ApiError } from "../lib/api.ts";
import type { Greeting } from "../spec.ts";

// Declares the colors it accepts: the greeting may be pending and may fail
// with an ApiError, so the caller must place it inside Loading and Errored.
export const GreetingCard = component(function* GreetingCard(
  props: Props<{ greeting: Source<Greeting, ApiError, true> }>,
) {
  return view(function* () {
    return (
      <section class="mt-6 max-w-md rounded-xl border border-sky-200 bg-sky-50 p-6 shadow-sm">
        <h2 class="text-lg font-semibold">From the API</h2>
        <p id="greeting" class="mt-2 text-slate-700">
          {yield* props.greeting.message}
        </p>
        <p id="served-at" class="mt-1 text-sm text-slate-500">
          Served at {yield* props.greeting.servedAt}
        </p>
      </section>
    );
  });
});
