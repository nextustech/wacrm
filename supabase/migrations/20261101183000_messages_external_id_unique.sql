-- Inbound webhook deliveries were de-duplicated in application code with a
-- check-then-insert, which is not atomic. Meta re-delivers a message whenever
-- the handler is slow to answer — and the handler downloads the message's media
-- before it inserts anything, so a photo kept the response open long enough to
-- be re-delivered again and again.
--
-- Worse, the guard read its row with PostgREST's `.maybeSingle()`, which errors
-- instead of returning data once more than one row matches. So the moment one
-- race was lost, the guard stopped working for that message id entirely: one
-- photo landed eight times, and the chatbot answered the customer eight times.
--
-- The application-side guard is fixed separately. This moves the actual
-- guarantee into the database, where concurrency can't defeat it.

-- 1. Fold existing duplicates into their earliest copy — a unique index cannot
--    be built while they exist. Replies that pointed at a later copy are moved
--    onto the survivor first, so no reply loses its context.
update messages m
   set reply_to_id = k.keep_id
  from (
    select
      id,
      first_value(id) over (
        partition by workspace_id, external_message_id
        order by created_at, id
      ) as keep_id
    from messages
    where external_message_id is not null
  ) k
 where k.id <> k.keep_id
   and m.reply_to_id = k.id;

delete from messages m
 using (
   select
     id,
     first_value(id) over (
       partition by workspace_id, external_message_id
       order by created_at, id
     ) as keep_id
   from messages
   where external_message_id is not null
 ) k
 where k.id <> k.keep_id
   and m.id = k.id;

-- 2. One row per provider message id, per workspace. A redelivered webhook now
--    fails its insert with 23505, which the handlers treat as "already
--    ingested" and stop on.
create unique index if not exists messages_workspace_external_id_uniq
  on public.messages (workspace_id, external_message_id)
  where external_message_id is not null;
