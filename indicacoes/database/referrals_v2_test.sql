begin;
do $$
declare p uuid;u uuid:=gen_random_uuid(); a uuid; c uuid; st text; code text; h text; rejected boolean:=false;
begin
 select user_id into a from public.user_roles where role='admin' limit 1;
 select body_hash into h from public.referral_terms where version='AB-2026-10-19.1';
 insert into public.referral_partners(full_name,email,phone,password_salt,password_hash,pix_type,pix_key,pix_holder,terms_version,terms_hash)
 values('QA Referral Transaction','qa-referral-'||u||'@example.invalid','5500000000000',repeat('a',40),repeat('b',64),'email','qa@example.invalid','QA Referral Transaction','AB-2026-10-19.1',h) returning id,referral_code into p,code;
 if not exists(select 1 from public.referral_acceptances where partner_id=p) then raise exception 'Acceptance missing';end if;
 insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
 values(u,'qa-owner-'||u||'@example.invalid',jsonb_build_object('signup_type','owner','name','QA Owner','phone','0000000001','shopName','QA rollback only','slug','qa-'||u,'referral_code',code),now(),now());
 select id into c from public.referral_conversions where owner_id=u and partner_id=p;
 if c is null then raise exception 'Attribution missing';end if;
 perform public.referral_admin_transition(c,a,'confirm_payment','QA-FIRST-'||u,now(),null,null);
 begin perform public.referral_admin_transition(c,a,'approve',null,null,'Conferido sem estorno',null);exception when others then rejected:=true;end;
 if not rejected then raise exception '7 day rule bypassed';end if;
 update public.referral_conversions set eligible_at=now()-interval '1 second' where id=c;
 perform public.referral_admin_transition(c,a,'approve',null,null,'Conferido sem estorno',null);
 rejected:=false;
 begin perform public.referral_admin_transition(c,a,'mark_paid','QA-PIX-'||u,null,null,'wrong-key');exception when others then rejected:=true;end;
 if not rejected then raise exception 'Pix change protection failed';end if;
 perform public.referral_admin_transition(c,a,'mark_paid','QA-PIX-'||u,null,null,'qa@example.invalid');
 rejected:=false;
 begin perform public.referral_admin_transition(c,a,'mark_paid','QA-PIX2-'||u,null,null,'qa@example.invalid');exception when others then rejected:=true;end;
 if not rejected then raise exception 'Double payout accepted';end if;
 if (select count(*) from public.referral_audit where conversion_id=c)<>3 then raise exception 'Audit incomplete';end if;
 -- A normal owner is never a master.
 rejected:=false;
 begin perform public.referral_admin_transition(c,u,'reverse',null,null,'Unauthorized attempt',null);exception when others then rejected:=true;end;
 if not rejected then raise exception 'Unauthorized transition accepted';end if;
 -- Editing metadata after signup does not change attribution.
 update auth.users set raw_user_meta_data=raw_user_meta_data||'{"referral_code":"OTHER"}'::jsonb where id=u;
 if (select code_snapshot from public.referral_conversions where id=c)<>code then raise exception 'Attribution changed';end if;
end $$;
select 'PASS: attribution, acceptance, 7-day hold, Pix-change guard, double-payment guard, admin authorization, audit, immutable attribution' as result;
rollback;
