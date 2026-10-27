create table if not exists sealed_batches (
  id text primary key,
  salt_auth text not null,
  auth_hash text not null,
  salt_enc text not null,
  expires_at timestamptz not null,
  max_downloads integer not null,
  download_count integer not null default 0,
  failed_attempts integer not null default 0,
  grant_token text,
  grant_expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists sealed_batches_expires_at_idx on sealed_batches (expires_at);
create index if not exists sealed_batches_grant_token_idx on sealed_batches (grant_token);

alter table sealed_files add column if not exists batch_id text;
create index if not exists sealed_files_batch_id_idx on sealed_files (batch_id);

create table if not exists upload_chunks (
  upload_id text not null,
  file_index integer not null,
  chunk_index integer not null,
  payload text not null,
  created_at timestamptz not null default now(),
  primary key (upload_id, file_index, chunk_index)
);
