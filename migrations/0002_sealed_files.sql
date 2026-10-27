create table if not exists sealed_files (
  id text primary key,
  original_name text not null,
  mime_type text not null,
  size_bytes integer not null,
  ciphertext text not null,
  salt_enc text not null,
  iv text not null,
  salt_auth text not null,
  auth_hash text not null,
  expires_at timestamptz not null,
  max_downloads integer not null,
  download_count integer not null default 0,
  failed_attempts integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists sealed_files_expires_at_idx on sealed_files (expires_at);
