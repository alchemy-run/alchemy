CREATE TABLE connected_accounts (
  id text PRIMARY KEY,
  email text NOT NULL,
  created_at integer NOT NULL DEFAULT (unixepoch())
);
