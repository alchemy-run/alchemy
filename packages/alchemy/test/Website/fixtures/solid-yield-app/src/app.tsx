import { $event, $signal, component, view } from "solid-yield";

export const App = component(function* App() {
  const [count, setCount] = yield* $signal(0);
  const increment = $event(function* () {
    yield* setCount((yield* count) + 1);
  });
  return view(function* () {
    return (
      <main id="app">
        <h1>solid-yield-fixture</h1>
        <p id="count">{yield* count}</p>
        <button id="increment" onClick={yield* increment}>
          +
        </button>
      </main>
    );
  });
});
