-- Agende Barber: service-only referral ledger. No client direct table access.
alter table public.referral_partners
 add column if not exists pix_type text,
 add column if not exists pix_key text,
 add column if not exists pix_holder text,
 add column if not exists terms_version text,
 add column if not exists terms_hash text,
 add column if not exists consent_ip_hash text,
 add column if not exists consent_user_agent text;
create table public.referral_terms (
 version text primary key, body text not null, body_hash text not null,
 created_at timestamptz not null default now()
);
create table public.referral_acceptances (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references public.referral_partners(id),
 terms_version text not null references public.referral_terms(version), terms_hash text not null,
 accepted_at timestamptz not null default now(), ip_hash text, user_agent text
);
create table public.referral_conversions (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references public.referral_partners(id),
 barbershop_id uuid not null unique references public.barbershops(id),
 owner_id uuid not null unique references auth.users(id), code_snapshot text not null,
 shop_name text not null, status text not null default 'pending' check(status in ('pending','review','approved','paid','rejected','reversed')),
 commission_cents integer not null default 1500 check(commission_cents=1500),
 terms_version text not null references public.referral_terms(version),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 payment_reference text, first_paid_at timestamptz, eligible_at timestamptz,
 approved_at timestamptz, payout_due_at date, paid_at timestamptz, payout_reference text,
 pix_snapshot jsonb, reason text
);
create unique index referral_payment_reference_unique on public.referral_conversions(payment_reference) where payment_reference is not null;
create unique index referral_payout_reference_unique on public.referral_conversions(payout_reference) where payout_reference is not null;
create index referral_conversions_partner on public.referral_conversions(partner_id,created_at desc);
create table public.referral_audit (
 id uuid primary key default gen_random_uuid(), conversion_id uuid references public.referral_conversions(id),
 partner_id uuid references public.referral_partners(id), actor_id uuid, action text not null,
 details jsonb not null default '{}', created_at timestamptz not null default now()
);
alter table public.referral_terms enable row level security;
alter table public.referral_acceptances enable row level security;
alter table public.referral_conversions enable row level security;
alter table public.referral_audit enable row level security;
revoke all on public.referral_terms,public.referral_acceptances,public.referral_conversions,public.referral_audit,public.referral_partners from anon,authenticated;
grant all on public.referral_terms,public.referral_acceptances,public.referral_conversions,public.referral_audit,public.referral_partners to service_role;
create index referral_acceptances_partner on public.referral_acceptances(partner_id,accepted_at desc);
create index referral_audit_conversion on public.referral_audit(conversion_id,created_at desc);
create index referral_audit_partner on public.referral_audit(partner_id,created_at desc);

create or replace function app_private.referral_acceptance_audit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.terms_version is not null and (TG_OP='INSERT' or new.terms_version is distinct from old.terms_version or new.consent_at is distinct from old.consent_at) then
  if not exists(select 1 from public.referral_terms where version=new.terms_version and body_hash=new.terms_hash) then raise exception 'Versão dos termos inválida'; end if;
  insert into public.referral_acceptances(partner_id,terms_version,terms_hash,ip_hash,user_agent) values(new.id,new.terms_version,new.terms_hash,new.consent_ip_hash,new.consent_user_agent);
 end if;
 if TG_OP='UPDATE' and (new.pix_key is distinct from old.pix_key or new.pix_type is distinct from old.pix_type or new.pix_holder is distinct from old.pix_holder) then
  insert into public.referral_audit(partner_id,action,details) values(new.id,'pix_updated',jsonb_build_object('previous_type',old.pix_type,'new_type',new.pix_type));
 end if;
 return new;
end $$;
revoke all on function app_private.referral_acceptance_audit() from public,anon,authenticated;
create trigger referral_partner_acceptance after insert or update on public.referral_partners for each row execute function app_private.referral_acceptance_audit();

-- Runs only for a NEW shop. User-editable metadata identifies a referral; it never authorizes access or payment.
create or replace function app_private.capture_barber_referral() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.referral_partners%rowtype; meta jsonb; owner_email text; code text; digits text; st text; why text;
begin
 select raw_user_meta_data,email into meta,owner_email from auth.users where id=new.owner_id;
 code:=upper(trim(coalesce(meta->>'referral_code','')));
 if code='' then return new; end if;
 select * into p from public.referral_partners where referral_code=code and partner_status='active' and terms_version is not null;
 if not found then return new; end if;
 digits:=regexp_replace(coalesce(new.phone,''),'[^0-9]','','g');
 st:='pending';
 if lower(owner_email)=lower(p.email) or (length(digits)>=10 and right(digits,10)=right(p.phone,10)) then st:='rejected';why:='Autoindicação identificada por e-mail ou telefone.'; end if;
 insert into public.referral_conversions(partner_id,barbershop_id,owner_id,code_snapshot,shop_name,status,terms_version,reason)
 values(p.id,new.id,new.owner_id,p.referral_code,new.name,st,p.terms_version,why) on conflict do nothing;
 return new;
end $$;
revoke all on function app_private.capture_barber_referral() from public,anon,authenticated;
create trigger capture_barber_referral after insert on public.barbershops for each row execute function app_private.capture_barber_referral();

-- Invoker RPC, service role only. Atomic status transitions and audit prevent double payout marking.
create or replace function public.referral_admin_transition(p_id uuid,p_actor uuid,p_action text,p_reference text default null,p_paid_at timestamptz default null,p_reason text default null,p_pix_key text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.referral_conversions%rowtype; p public.referral_partners%rowtype; days integer:=0; due date; previous text;
begin
 if not exists(select 1 from public.user_roles where user_id=p_actor and role='admin') then raise exception 'Acesso exclusivo do master'; end if;
 select * into r from public.referral_conversions where id=p_id for update;
 if not found then raise exception 'Indicação não encontrada'; end if;
 previous:=r.status;
 select * into p from public.referral_partners where id=r.partner_id for update;
 if p_action='confirm_payment' then
  if r.status<>'pending' then raise exception 'Pagamento já conferido ou indicação encerrada'; end if;
  if p_paid_at is null or p_paid_at>now() or p_paid_at<r.created_at then raise exception 'Data do pagamento inválida'; end if;
  if length(trim(coalesce(p_reference,'')))<5 or length(p_reference)>200 then raise exception 'Informe a referência única da primeira mensalidade'; end if;
  r.status:='review';r.first_paid_at:=p_paid_at;r.eligible_at:=greatest(p_paid_at+interval '7 days',now());r.payment_reference:=trim(p_reference);
  due:=(r.eligible_at at time zone 'America/Sao_Paulo')::date;
  while days<10 loop
   due:=due+1;
   if extract(isodow from due)<6 then days:=days+1; end if;
  end loop;
  r.payout_due_at:=due;
 elsif p_action='approve' then
  if r.status<>'review' or now()<r.eligible_at then raise exception 'Aguarde 7 dias após o primeiro pagamento confirmado'; end if;
  if p.pix_key is null or p.pix_holder is null or p.terms_version is null then raise exception 'Indicador precisa completar Pix e aceite'; end if;
  if p.partner_status<>'active' then raise exception 'Indicador indisponível'; end if;
  if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Registre a conferência de elegibilidade e ausência de estorno'; end if;
  r.status:='approved';r.approved_at:=now();r.reason:=p_reason;
 elsif p_action='mark_paid' then
  if r.status<>'approved' then raise exception 'Somente comissões aprovadas podem ser marcadas como pagas'; end if;
  if length(trim(coalesce(p_reference,'')))<5 or length(p_reference)>200 then raise exception 'Informe o identificador do comprovante Pix'; end if;
  if p.pix_key is null or p.partner_status<>'active' then raise exception 'Pix ou indicador indisponível'; end if;
  if p_pix_key is distinct from p.pix_key then raise exception 'Dados Pix alterados. Atualize e confira o destinatário antes de registrar'; end if;
  r.status:='paid';r.paid_at:=now();r.payout_reference:=trim(p_reference);
  r.pix_snapshot:=jsonb_build_object('type',p.pix_type,'key',p.pix_key,'holder',p.pix_holder);
 elsif p_action in ('reject','reverse') then
  if length(trim(coalesce(p_reason,'')))<10 then raise exception 'Informe um motivo com pelo menos 10 caracteres'; end if;
  if p_action='reject' and r.status not in ('pending','review','approved') then raise exception 'Indicação já encerrada'; end if;
  if p_action='reverse' and r.status<>'paid' then raise exception 'Apenas pagamentos realizados podem ser estornados no controle'; end if;
  r.status:=case when p_action='reject' then 'rejected' else 'reversed' end;r.reason:=p_reason;
 else raise exception 'Ação inválida'; end if;
 update public.referral_conversions set status=r.status,updated_at=now(),payment_reference=r.payment_reference,first_paid_at=r.first_paid_at,eligible_at=r.eligible_at,approved_at=r.approved_at,payout_due_at=r.payout_due_at,paid_at=r.paid_at,payout_reference=r.payout_reference,pix_snapshot=r.pix_snapshot,reason=r.reason where id=r.id;
 insert into public.referral_audit(conversion_id,partner_id,actor_id,action,details) values(r.id,r.partner_id,p_actor,p_action,jsonb_build_object('from',previous,'to',r.status,'reference',p_reference,'reason',p_reason));
 return jsonb_build_object('id',r.id,'status',r.status);
end $$;
revoke all on function public.referral_admin_transition(uuid,uuid,text,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.referral_admin_transition(uuid,uuid,text,text,timestamptz,text,text) to service_role;

insert into public.referral_terms(version,body,body_hash) values ('AB-2026-10-19.1','REGULAMENTO DO PROGRAMA INDIQUE & GANHE — AGENDE BARBER
Versão AB-2026-10-19.1

1. Participação. Programa exclusivo do Agende Barber, operado por Douglas Ferreira de Lima, responsável pelo programa. Participação gratuita para maiores de 18 anos, com nome verdadeiro, e-mail, WhatsApp e chave Pix de sua titularidade. Não é necessário contratar o sistema para indicar.

2. Identificação. O indicador recebe um código e link individual. A nova barbearia deve concluir seu primeiro cadastro pelo link ou informar o código no cadastro. O vínculo é registrado nesse momento e não pode ser trocado pelo indicador. Sem o código no cadastro não há atribuição automática; divergências podem ser apresentadas ao suporte com evidências. Compartilhar um link ou fazer um cadastro, por si só, não gera pagamento.

3. Recompensa. R$ 15,00, uma única vez por nova barbearia e responsável elegíveis, após a primeira mensalidade efetivamente paga e conferida. O plano divulgado é de R$ 79,90/mês. A comissão não é recorrente e não incide sobre renovações, teste gratuito, cadastros duplicados, autoindicação, contratação fictícia ou clientes já cadastrados antes da indicação. Descontos e condições especiais exigem confirmação prévia da elegibilidade pelo suporte; não geram promessa automática de recompensa.

4. Conferência e prazo. A equipe confere o recebimento da primeira mensalidade e a ausência de fraude, duplicidade, cancelamento com reembolso ou estorno. Há uma espera de 7 dias corridos após esse pagamento. A liberação ocorre após essa espera e a confirmação do pagamento, prevalecendo a data posterior. O Pix será realizado em até 10 dias úteis após a liberação. O painel mostra o andamento e a data limite; o cálculo exibido desconsidera somente sábados e domingos, podendo resultar em prazo anterior ao limite com feriados. A equipe deve concluir a conferência dentro desse prazo ou informar uma pendência justificada. Havendo dados Pix incorretos ou pendência documentada, o prazo fica suspenso enquanto durar a pendência, comunicada ao participante, retomando pelo saldo de dias após a regularização.

5. Pix. O participante informa tipo, chave e nome completo do titular e declara ser titular da conta. A validação do formato da chave não confirma sua existência ou titularidade no banco. Antes da transferência, a equipe confere o destinatário no aplicativo bancário. A chave pode ser atualizada no painel; pagamentos já concluídos preservam os dados usados na transferência. Não solicitamos senha bancária, cartão ou pagamento antecipado para liberar comissões.

6. Cancelamentos e prevenção a abuso. Antes do pagamento da recompensa, a comissão poderá ser recusada com motivo registrado em caso de autoindicação, duplicidade, fraude ou devolução da primeira mensalidade. Depois de paga, uma divergência será registrada e tratada individualmente, com direito de contestação; este regulamento não autoriza débito automático na conta Pix nem retenção indiscriminada de outras comissões. É proibido spam, uso indevido de dados de terceiros, promessa de ganhos garantidos, divulgação enganosa e apresentação como representante autorizado a negociar em nome do Agende Barber.

7. Aceite e histórico. A adesão exige marcação expressa, sem caixa previamente selecionada. Registramos a versão e o conteúdo do regulamento, data e hora do aceite, identificação da conta, hash do IP e informação do navegador para demonstrar a adesão e prevenir abuso. Novas versões serão apresentadas para novo aceite, sem retirar direitos já adquiridos nem alterar retroativamente as regras de indicações anteriores.

8. Privacidade. Nome, e-mail, WhatsApp, dados Pix, código, indicações, eventos de pagamento e registros do aceite são utilizados para executar e administrar o programa, prevenir fraude, atender solicitações e cumprir obrigações aplicáveis. O acesso é restrito ao participante, à equipe autorizada e aos prestadores de infraestrutura necessários, inclusive Supabase e Vercel, que podem processar dados fora do Brasil. Não publicamos chaves Pix nem dados de acesso. O participante visualiza apenas suas indicações e os dados mínimos para acompanhar a comissão. Os dados são mantidos durante a participação e, depois, apenas pelo período necessário para obrigações legais e defesa de direitos; registros sem necessidade serão eliminados ou anonimizados. Pedidos de acesso, correção, exclusão, informações sobre retenção ou encerramento podem ser feitos pelo suporte. A exclusão pode ser limitada por obrigações legais e registros necessários de pagamentos e disputas. O aceite do regulamento não inclui autorização genérica para marketing.

9. Encerramento e alterações. O participante pode solicitar saída a qualquer momento. A equipe pode encerrar o programa para novas indicações mediante aviso, preservando comissões elegíveis e pendentes. A participação não exige exclusividade e não cria, por si só, vínculo empregatício, sociedade ou representação comercial; a natureza de eventual relação é definida pelos fatos e pela legislação aplicável.

10. Atendimento e contestação. Suporte do Agende Barber: WhatsApp (42) 99831-9122. Informe seu código e a barbearia relacionada para contestar uma decisão. Direitos previstos em lei e o acesso aos órgãos competentes permanecem preservados.
','75c466d36c93cac7daf63795f0df4b29e9dbd368089baee96fb986ab75530bd3');
