-- Chunk rows stay under PostgreSQL's 1 GB field limit and let a download
-- read one slice instead of a whole file. Names and types are fixed-size
-- ciphertext (name_ct, mime_ct); the clear columns are only for older seals.

alter table upload_chunks add column if not exists iv text;
alter table upload_chunks add column if not exists payload_bin bytea;

alter table sealed_files add column if not exists file_nonce text;
alter table sealed_files add column if not exists name_iv text;
alter table sealed_files add column if not exists name_ct text;
alter table sealed_files add column if not exists mime_iv text;
alter table sealed_files add column if not exists mime_ct text;
alter table sealed_files add column if not exists chunk_count integer;

alter table sealed_files alter column original_name drop not null;
alter table sealed_files alter column mime_type drop not null;
alter table sealed_files alter column size_bytes drop not null;
alter table sealed_files alter column ciphertext drop not null;
alter table sealed_files alter column iv drop not null;

create table if not exists sealed_file_chunks (
  file_id text not null,
  chunk_index integer not null,
  iv text not null,
  payload bytea not null,
  primary key (file_id, chunk_index)
);
