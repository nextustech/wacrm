-- Admit the three new channels to the `inbox_channel` enum.
--
-- `conversations.channel` and `channel_identities`-adjacent columns are typed
-- with this enum, so without these values every Viber / LINE / WeChat insert
-- fails at runtime with "invalid input value for enum". Same pattern as
-- 20261025233000_social_inbox_channels.sql.

alter type public.inbox_channel add value if not exists 'viber';
alter type public.inbox_channel add value if not exists 'line';
alter type public.inbox_channel add value if not exists 'wechat';

-- Chatbot deployments are gated by a CHECK list, not the enum above, so the
-- three channels have to be admitted there too or a bot can never be deployed
-- on them (the inbound handlers already call dispatchChannelBot with them).
alter table public.chatbot_deployments
  drop constraint if exists chatbot_deployments_channel_check;
alter table public.chatbot_deployments
  add constraint chatbot_deployments_channel_check
  check (channel in ('whatsapp', 'instagram', 'messenger', 'telegram', 'livechat', 'web', 'sms', 'email', 'tiktok', 'viber', 'line', 'wechat'));

notify pgrst, 'reload schema';
