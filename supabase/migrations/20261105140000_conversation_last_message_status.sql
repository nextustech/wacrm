-- The inbox list shows a double-tick beside the preview whenever the last
-- message was ours, but it had no way to tell "delivered" from "read": the
-- conversation row carried no status, so the tick stayed grey while the same
-- message turned blue inside the thread. Mirror the last outbound message's
-- status onto the conversation so the list can colour the tick.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_message_status public.message_status;

-- 1. New message: remember its status when it is ours, clear it when it is theirs.
CREATE OR REPLACE FUNCTION public.tg_message_after_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_internal THEN RETURN NEW; END IF;
  UPDATE public.conversations c
    SET last_message_at = NEW.created_at,
        last_message_preview = left(coalesce(NEW.body, NEW.message_type::text), 200),
        last_message_from = CASE WHEN NEW.direction::text = 'inbound' THEN 'contact' ELSE 'agent' END,
        last_message_status = CASE WHEN NEW.direction::text = 'inbound' THEN NULL ELSE NEW.status END,
        unread_count = CASE WHEN NEW.direction::text = 'inbound' THEN c.unread_count + 1 ELSE c.unread_count END,
        first_response_at = CASE
          WHEN c.first_response_at IS NULL AND NEW.direction::text = 'outbound' THEN NEW.created_at
          ELSE c.first_response_at END,
        updated_at = now()
    WHERE c.id = NEW.conversation_id;
  RETURN NEW;
END $$;

-- 2. Receipt arrives later (sent -> delivered -> read). Only the message that is
--    still the conversation's last one may move the conversation's status.
CREATE OR REPLACE FUNCTION public.tg_message_status_after_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_internal OR NEW.direction::text = 'inbound' THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Several senders overwrite last_message_at with their own clock, so the
    -- timestamp cannot be compared directly; ask instead whether anything
    -- newer exists in the thread.
    UPDATE public.conversations c
      SET last_message_status = NEW.status
      WHERE c.id = NEW.conversation_id
        AND NOT EXISTS (
          SELECT 1 FROM public.messages m
           WHERE m.conversation_id = NEW.conversation_id
             AND m.is_internal = false
             AND m.deleted_at IS NULL
             AND m.created_at > NEW.created_at
        );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_message_status_after_update ON public.messages;
CREATE TRIGGER trg_message_status_after_update
  AFTER UPDATE OF status ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_message_status_after_update();

-- 3. Backfill from the newest non-internal message of each conversation.
--    DISTINCT ON rather than a correlated LATERAL: the table an UPDATE targets
--    cannot be referenced from a LATERAL item in its own FROM clause
--    (42P10 "invalid reference to FROM-clause entry").
WITH latest AS (
  SELECT DISTINCT ON (m.conversation_id)
         m.conversation_id,
         m.status,
         m.direction
    FROM public.messages m
   WHERE m.is_internal = false
     AND m.deleted_at IS NULL
   ORDER BY m.conversation_id, m.created_at DESC
)
UPDATE public.conversations c
   SET last_message_status = latest.status
  FROM latest
 WHERE latest.conversation_id = c.id
   AND latest.direction::text = 'outbound'
   AND c.last_message_status IS DISTINCT FROM latest.status;
