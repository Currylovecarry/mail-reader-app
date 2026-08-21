-- OrderBridge multi-tenant schema for Supabase.
-- Run this migration in the Supabase SQL editor before deploying.

create extension if not exists pgcrypto;

create table if not exists public.mailbox_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  imap_host text not null,
  imap_port integer not null check (imap_port between 1 and 65535),
  imap_secure boolean not null default true,
  imap_mailbox text not null default 'INBOX',
  smtp_host text not null,
  smtp_port integer not null check (smtp_port between 1 and 65535),
  smtp_secure boolean not null default true,
  auth_code_ciphertext text not null,
  auth_code_iv text not null,
  auth_code_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.llm_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'deepseek' check (provider = 'deepseek'),
  base_url text not null default 'https://api.deepseek.com',
  model text not null default 'deepseek-v4-flash',
  api_key_ciphertext text not null,
  api_key_iv text not null,
  api_key_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mail_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  external_id text not null,
  message_id text not null default '',
  uid text not null default '',
  message_at timestamptz,
  payload jsonb not null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, external_id)
);

create index if not exists mail_messages_user_message_at_idx
  on public.mail_messages (user_id, message_at desc nulls last, id desc);

create table if not exists public.mail_sync_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null default 'imap_smtp',
  alias text not null default '',
  sync_state jsonb not null default '{}'::jsonb,
  sync_log jsonb not null default '{}'::jsonb,
  imported_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.recognition_orders (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  email_id text not null,
  company text not null default '',
  contact_person text not null default '',
  phone text not null default '',
  project_name text not null default '',
  delivery_terms text not null default '',
  delivery_date text not null default '',
  destination text not null default '',
  payment_terms text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, email_id)
);

create table if not exists public.recognition_order_items (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  recognition_order_id bigint not null references public.recognition_orders(id) on delete cascade,
  line_no integer not null,
  model_raw text not null,
  model_normalized text not null,
  quantity numeric,
  unit text not null default '',
  confidence double precision not null default 0 check (confidence between 0 and 1),
  unique (recognition_order_id, line_no)
);

create index if not exists recognition_order_items_user_model_idx
  on public.recognition_order_items (user_id, model_normalized);

create table if not exists public.product_catalog (
  id bigint generated always as identity primary key,
  product_code text not null unique,
  normalized_code text not null unique,
  product_name text not null default '',
  spec text not null default '',
  unit text not null default '',
  price numeric,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_match_results (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  recognition_item_id bigint not null unique references public.recognition_order_items(id) on delete cascade,
  query_model_raw text not null,
  query_normalized_code text not null,
  match_status text not null check (match_status in ('exact_match', 'fuzzy_match', 'no_match')),
  match_method text not null,
  final_score double precision not null default 0,
  spec_warning text not null default '',
  need_manual_review boolean not null default true,
  review_reason text not null default '',
  selected_product_id bigint references public.product_catalog(id) on delete set null,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'auto_confirmed', 'confirmed', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_match_candidates (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  match_result_id bigint not null references public.product_match_results(id) on delete cascade,
  product_id bigint not null references public.product_catalog(id) on delete cascade,
  rank integer not null check (rank between 1 and 3),
  fuzzy_score double precision not null,
  spec_score double precision not null,
  final_score double precision not null,
  match_reason text not null default '',
  unique (match_result_id, rank),
  unique (match_result_id, product_id)
);

create table if not exists public.mail_workflows (
  user_id uuid not null references auth.users(id) on delete cascade,
  email_id text not null,
  status text not null check (status in (
    'pending_recognition', 'pending_confirmation', 'manual_review',
    'recognition_failed', 'not_applicable', 'processed'
  )),
  recognition_order_id bigint references public.recognition_orders(id) on delete set null,
  recognition_provider text not null default '',
  recognition_status text not null default '',
  reason text not null default '',
  review_note text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, email_id)
);

alter table public.mailbox_connections enable row level security;
alter table public.llm_connections enable row level security;
alter table public.mail_messages enable row level security;
alter table public.mail_sync_states enable row level security;
alter table public.recognition_orders enable row level security;
alter table public.recognition_order_items enable row level security;
alter table public.product_match_results enable row level security;
alter table public.product_match_candidates enable row level security;
alter table public.mail_workflows enable row level security;
alter table public.product_catalog enable row level security;

create policy "users manage their mailbox connection" on public.mailbox_connections
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage their llm connection" on public.llm_connections
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage their mails" on public.mail_messages
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage their mail sync state" on public.mail_sync_states
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage their recognition orders" on public.recognition_orders
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage their recognition items" on public.recognition_order_items
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage their product match results" on public.product_match_results
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage their product match candidates" on public.product_match_candidates
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage their workflows" on public.mail_workflows
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "authenticated users can read product catalog" on public.product_catalog
  for select to authenticated using (true);

insert into storage.buckets (id, name, public)
values ('mail-attachments', 'mail-attachments', false)
on conflict (id) do nothing;

create policy "users read their own attachment objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'mail-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
