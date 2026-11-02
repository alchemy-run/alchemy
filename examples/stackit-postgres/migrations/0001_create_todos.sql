CREATE TABLE todos (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false
);
