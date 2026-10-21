-- Partner accounts are independent of Supabase Auth: reset only their own password.
-- Tokens are never stored in plaintext. Consume them atomically and invalidate old sessions.
CREATE TABLE IF NOT EXISTS public.referral_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.referral_partners(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS referral_password_resets_partner_created
  ON public.referral_password_resets(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS referral_password_resets_expiry
  ON public.referral_password_resets(expires_at) WHERE used_at IS NULL;

ALTER TABLE public.referral_password_resets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referral_password_resets FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_password_resets TO service_role;

-- Reuse existing hourly audit/rate-limit buckets without storing email addresses.
ALTER TABLE public.referral_registration_attempts
 DROP CONSTRAINT IF EXISTS referral_registration_attempts_action_check;
ALTER TABLE public.referral_registration_attempts
 ADD CONSTRAINT referral_registration_attempts_action_check
 CHECK (action IN ('register','login','reset_request','reset_email','reset_password'));

CREATE OR REPLACE FUNCTION public.referral_consume_password_reset(
  p_token_hash text,
  p_password_salt text,
  p_password_hash text,
  p_password_iterations integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE reset_row public.referral_password_resets%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$'
     OR p_password_salt IS NULL OR p_password_salt !~ '^[a-f0-9]{40}$'
     OR p_password_hash IS NULL OR p_password_hash !~ '^[a-f0-9]{64}$'
     OR p_password_iterations <> 210000 THEN
    RETURN false;
  END IF;
  SELECT * INTO reset_row
  FROM public.referral_password_resets
  WHERE token_hash=p_token_hash AND used_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.referral_partners
    WHERE id=reset_row.partner_id AND partner_status='active'
  ) THEN RETURN false; END IF;
  UPDATE public.referral_partners
    SET password_salt=p_password_salt, password_hash=p_password_hash,
        password_iterations=p_password_iterations, updated_at=now()
    WHERE id=reset_row.partner_id;
  UPDATE public.referral_password_resets
    SET used_at=now()
    WHERE partner_id=reset_row.partner_id AND used_at IS NULL;
  UPDATE public.referral_partner_sessions
    SET revoked_at=now()
    WHERE partner_id=reset_row.partner_id AND revoked_at IS NULL;
  INSERT INTO public.referral_audit (partner_id,action,details)
    VALUES (reset_row.partner_id,'partner_password_reset',
      jsonb_build_object('method','email_link'));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.referral_consume_password_reset(text,text,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.referral_consume_password_reset(text,text,text,integer)
  TO service_role;
