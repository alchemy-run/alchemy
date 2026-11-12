CREATE SCHEMA crm;

CREATE TABLE crm.customers (
  id integer PRIMARY KEY,
  email text NOT NULL,
  region text NOT NULL
);

INSERT INTO crm.customers (id, email, region) VALUES
  (1, 'ada@example.com', 'EU'),
  (2, 'grace@example.com', 'US'),
  (3, 'edsger@example.com', 'EU');
