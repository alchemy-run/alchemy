CREATE SCHEMA shop;

CREATE TABLE shop.orders (
  id integer PRIMARY KEY,
  customer text NOT NULL,
  amount numeric(10, 2) NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO shop.orders (id, customer, amount) VALUES
  (1, 'ada', 42.50),
  (2, 'grace', 99.00),
  (3, 'edsger', 7.25);
