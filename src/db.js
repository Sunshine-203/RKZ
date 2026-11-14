// PostgreSQL connection + schema. Every table carries user_id so each visitor's data stays separate.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 5,
});

const SCHEMA = `
create table if not exists users (
  id uuid primary key,
  daily_minutes int not null default 60,
  created_at timestamptz not null default now()
);

create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  scene text not null default 'plain',
  sound_on boolean not null default false,
  focus_minutes int not null default 25,
  created_at timestamptz not null default now()
);
create unique index if not exists channels_user_name on channels (user_id, lower(name));

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  channel_id uuid references channels(id) on delete set null,
  title text not null,
  description text not null default '',
  deadline date not null,
  created_at timestamptz not null default now()
);
create index if not exists assignments_user on assignments (user_id);

create table if not exists steps (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignments(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  ord int not null,
  title text not null,
  minutes int not null,
  done_minutes int not null default 0,
  status text not null default 'todo',
  source text not null default 'manual',
  schedule jsonb not null default '[]'::jsonb,
  unscheduled_minutes int not null default 0
);
create index if not exists steps_assignment on steps (assignment_id);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { pool, migrate };
