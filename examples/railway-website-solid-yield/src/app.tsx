import { $event, $memo, $signal, component, Errored, Loading, refresh, view } from "solid-yield";
import { Card } from "./components/Card.tsx";
import { GreetingCard } from "./components/GreetingCard.tsx";
import { ApiError, getGreeting } from "./lib/api.ts";
import { runEffect } from "./lib/effect.ts";

export const App = component(function* App() {
  // Read path: the memo runs the Effect. It is pending until the fiber
  // settles and fails with the Effect's typed error, ApiError.
  const greeting = yield* $memo(function* () {
    return yield* runEffect(getGreeting, (defect) => new ApiError(String(defect)));
  });
  // Event path: refreshing the memo re-runs the Effect.
  const reload = $event(function* () {
    yield* refresh(greeting);
  });
  const [count, setCount] = yield* $signal(0);
  const increment = $event(function* () {
    yield* setCount((yield* count) + 1);
  });

  return view(function* () {
    return (
      <main class="mx-auto max-w-xl">
        <h1 class="text-3xl font-bold">Hello from solid-yield!</h1>
        {
          yield* Card({
            title: "Styled with Tailwind CSS",
            body: "This card is a yield component styled with Tailwind utilities.",
          })
        }
        {
          yield* Errored({
            catch: [ApiError],
            fallback: (err) => <p class="mt-6 text-rose-600">API error: {err().message}</p>,
            children: function* () {
              return (
                <>
                  {
                    yield* Loading({
                      fallback: "Loading greeting…",
                      children: function* () {
                        return <>{yield* GreetingCard({ greeting })}</>;
                      },
                    })
                  }
                </>
              );
            },
          })
        }
        <button
          id="reload"
          class="mt-6 mr-3 rounded-xl border border-sky-500 px-5 py-3 font-medium text-sky-600 hover:bg-sky-50"
          onClick={yield* reload}
        >
          Refresh greeting
        </button>
        <button
          id="increment"
          class="mt-6 rounded-xl bg-sky-500 px-5 py-3 font-medium text-white hover:bg-sky-400"
          onClick={yield* increment}
        >
          Clicked {yield* count} times
        </button>
      </main>
    );
  });
});
