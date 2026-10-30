alter table sealed_batches add column if not exists client_key text;

create index if not exists sealed_batches_client_key_idx on sealed_batches (client_key);
