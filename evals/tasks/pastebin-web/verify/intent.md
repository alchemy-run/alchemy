# Product intent: pastebin-web (hidden from the agent)

The customer asked for: a pastebin with a TanStack Start frontend and an
alchemy Workers backend, durable storage (Durable Objects or D1), where a
visitor pastes text, gets a shareable link, and anyone with the link sees the
paste — durably.

## Checks

- `frontend-serves` — GET / returns a real HTML page for the pastebin app
  (an actual UI with a way to enter a paste — not a placeholder, error page,
  or bare JSON).
- `create-paste` — you can create a paste containing your unique marker
  string through the app's own creation flow (the form's submit endpoint, the
  server function, or whatever the frontend actually calls — discovered from
  the served page/JS, not guessed from convention alone).
- `share-link` — creating a paste yields a distinct shareable URL (path or
  id-bearing link), and fetching THAT URL from a fresh session (no cookies)
  returns a page or response containing the marker string.
- `persistence` — the paste is served from durable storage, not process
  memory: the share link still returns the marker on repeated fetches, and a
  second, different paste gets a different link with its own content (no
  global single-slot storage).
- `not-found-sane` — a made-up paste URL fails gracefully (404 page or clear
  "not found" state, not a crash/500 or an empty 200 pretending to be a paste).
