-- Relaxes the immutability guard for boundaries that have not yet occurred.
--
-- WHY THIS EXISTS, AND WHY IT IS NOT A WEAKENING
--
-- 0009 froze `effective_until` the moment it was written. That was too strict,
-- and the governance suite found the case: once a change is SCHEDULED, the
-- outgoing rule is already closed at the future start instant, so an urgent
-- correction published today would have to begin before a rule that is already
-- in force. There was no way to make an emergency change while any scheduled
-- change was pending — for a screen whose entire job is compliance, "you cannot
-- fix this until Tuesday" is not an acceptable answer.
--
-- The principle that actually matters is narrower than "nothing changes". It is
-- that NOTHING WHICH HAS ALREADY GOVERNED A SALE MAY CHANGE. A boundary in the
-- future has governed nothing: no order was checked against it, no receipt
-- cites it, and moving it rewrites no history. A boundary in the past has
-- governed every sale up to it, and stays frozen forever.
--
-- So `effective_until` may be moved only while both the old and the new value
-- are still ahead of the clock. The instant it passes, it is permanent. Every
-- other column remains untouchable from the moment it is written, DELETE is
-- still refused outright, and a closed rule can never be reopened.

CREATE OR REPLACE FUNCTION purchase_limit_rules_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'purchase_limit_rules is append-only: rule % may not be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Unchanged from 0009: the value columns are permanent from the moment they
  -- are written, because an order line cites this row as its authority.
  IF NEW.id                          IS DISTINCT FROM OLD.id
  OR NEW.cannabis_class              IS DISTINCT FROM OLD.cannabis_class
  OR NEW.version                     IS DISTINCT FROM OLD.version
  OR NEW.equivalent_grams_per_gram   IS DISTINCT FROM OLD.equivalent_grams_per_gram
  OR NEW.daily_equivalent_grams_cap  IS DISTINCT FROM OLD.daily_equivalent_grams_cap
  OR NEW.daily_concentrate_grams_cap IS DISTINCT FROM OLD.daily_concentrate_grams_cap
  OR NEW.effective_from              IS DISTINCT FROM OLD.effective_from
  OR NEW.change_reason               IS DISTINCT FROM OLD.change_reason
  OR NEW.published_by                IS DISTINCT FROM OLD.published_by
  OR NEW.published_at                IS DISTINCT FROM OLD.published_at
  OR NEW.reauthenticated_at          IS DISTINCT FROM OLD.reauthenticated_at
  OR NEW.supersedes_rule_id          IS DISTINCT FROM OLD.supersedes_rule_id
  OR NEW.notes                       IS DISTINCT FROM OLD.notes
  OR NEW.created_at                  IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'purchase_limit_rules is immutable: publish a new version instead of editing rule %',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.effective_until IS DISTINCT FROM OLD.effective_until THEN
    -- A boundary that has already passed governed real sales. Frozen.
    IF OLD.effective_until IS NOT NULL AND OLD.effective_until <= now() THEN
      RAISE EXCEPTION
        'rule % closed at %, which has already passed; that boundary cannot be moved',
        OLD.id, OLD.effective_until
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Reopening a closed rule is not a correction, it is a second life.
    IF NEW.effective_until IS NULL THEN
      RAISE EXCEPTION
        'rule % cannot be reopened once closed', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Nor may a rule be retroactively ended before orders it already governed.
    IF NEW.effective_until < now() - interval '1 minute' THEN
      RAISE EXCEPTION
        'rule % cannot be closed in the past', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- One successor, recorded once. Unchanged from 0009.
  IF OLD.superseded_by_rule_id IS NOT NULL
     AND NEW.superseded_by_rule_id IS DISTINCT FROM OLD.superseded_by_rule_id THEN
    RAISE EXCEPTION
      'rule % already records a successor', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
