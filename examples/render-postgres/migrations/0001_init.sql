CREATE TABLE IF NOT EXISTS alchemy_render_example (
  id SERIAL PRIMARY KEY,
  status TEXT NOT NULL
);

INSERT INTO alchemy_render_example (status) VALUES ('ready');
