create table if not exists upload_sessions (
  id text primary key,
  client_ip text,
  state text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_sessions_state_check check (state in ('pending', 'finished', 'cancelled'))
);

create index if not exists upload_sessions_state_updated_at_idx on upload_sessions (state, updated_at);
create index if not exists upload_sessions_client_ip_state_idx on upload_sessions (client_ip, state);
