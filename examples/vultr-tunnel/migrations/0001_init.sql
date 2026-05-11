CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO messages (body) VALUES
  ('hello from migrations'),
  ('this row was seeded at deploy time'),
  ('vultr managed postgres works');
