import { $event, $memo, $signal, attempt, component, Errored, Loading, view } from "solid-yield";
import { Card } from "./components/Card.tsx";
import { GreetingCard } from "./components/GreetingCard.tsx";
import { ApiError, fetchGreeting } from "./lib/api.ts";

export const App = component(function* App() {
  const greeting = yield* $memo(function* () {
    return yield* attempt(
      () => fetchGreeting(),
      (cause) => new ApiError(cause instanceof Error ? cause.message : String(cause)),
    );
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
