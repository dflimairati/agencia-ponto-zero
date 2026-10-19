import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const allowedOrigins = new Set([
  "https://central-indicacoes.vercel.app",
  "https://central-indicacoes-dflimairatis-projects.vercel.app",
  "https://indicacoes.agendebarber.com",
  "https://agendebarber.com",
  "https://www.agendebarber.com",
  "https://barbershop-elite-app.vercel.app",
]);
const TERMS_VERSION="AB-2026-10-19.1";
const TERMS_HASH="75c466d36c93cac7daf63795f0df4b29e9dbd368089baee96fb986ab75530bd3";
const PARTNER_FIELDS="id,full_name,email,phone,referral_code,partner_status,created_at,pix_type,pix_key,pix_holder,terms_version,consent_at";
const encoder = new TextEncoder();
const jsonHeaders = (origin:string|null) => ({
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "null",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Vary": "Origin",
  "Cache-Control": "no-store",
});
function answer(origin:string|null,status:number,body:unknown):Response{
  return new Response(JSON.stringify(body),{status,headers:jsonHeaders(origin)});
}
function randHex(bytes=16):string{
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),b=>b.toString(16).padStart(2,"0")).join("");
}
async function sha256(value:string):Promise<string>{
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))),b=>b.toString(16).padStart(2,"0")).join("");
}
async function derive(password:string,salt:string,it=210000):Promise<string>{
  const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:encoder.encode(salt),iterations:it},key,256);
  return Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");
}
function constantTimeEqual(a:string,b:string):boolean{
  if(a.length!==b.length)return false;
  let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;
}
function partnerView(p:any){
  return {name:p.full_name,email:p.email,phone:p.phone,code:p.referral_code,status:p.partner_status,created_at:p.created_at,pix_type:p.pix_type,pix_key:p.pix_key,pix_holder:p.pix_holder,terms_version:p.terms_version,consent_at:p.consent_at,needs_terms:p.terms_version!==TERMS_VERSION};
}
const connection=createClient(Deno.env.get("SUPABASE_URL")||"",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",{auth:{persistSession:false,autoRefreshToken:false}});
async function newSession(partnerId:string):Promise<{token:string,expires_at:string}>{
  const token=randHex(32);
  const expires=new Date(Date.now()+7*86400000).toISOString();
  const {error}=await connection.from("referral_partner_sessions").insert({partner_id:partnerId,token_hash:await sha256(token),expires_at:expires});
  if(error)throw new Error("Não foi possível criar a sessão.");
  return {token,expires_at:expires};
}
async function getPartner(req:Request){
  const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"").trim();
  if(!/^[0-9a-f]{64}$/.test(token))return null;
  const {data:session,error}=await connection.from("referral_partner_sessions").select("id,partner_id,expires_at,revoked_at").eq("token_hash",await sha256(token)).maybeSingle();
  if(error||!session||session.revoked_at||Date.parse(session.expires_at)<Date.now())return null;
  const {data:partner}=await connection.from("referral_partners").select(PARTNER_FIELDS).eq("id",session.partner_id).maybeSingle();
  return partner&&partner.partner_status==="active"?{partner,session}:null;
}

function validatePix(input:any){
 const type=String(input.pix_type||"");let key=String(input.pix_key||"").trim();const holder=String(input.pix_holder||"").trim().replace(/\s+/g," ");
 if(holder.length<5||holder.length>120||!holder.includes(" "))throw Error("Informe o nome completo do titular do Pix.");
 if(type==="email"){key=key.toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)||key.length>254)throw Error("Chave Pix de e-mail inválida.");}
 else if(type==="phone"){key=key.replace(/\D/g,"");if(key.length===10||key.length===11)key="55"+key;if(!/^55\d{10,11}$/.test(key))throw Error("Informe o telefone Pix com DDD.");key="+"+key;}
 else if(type==="random"){key=key.toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key))throw Error("Chave aleatória Pix inválida.");}
 else if(type==="cpf"){
  key=key.replace(/\D/g,"");if(!/^\d{11}$/.test(key)||/^(\d)\1+$/.test(key))throw Error("CPF Pix inválido.");
  for(let n=9;n<11;n++){let sum=0;for(let i=0;i<n;i++)sum+=Number(key[i])*(n+1-i);const digit=(sum*10)%11%10;if(digit!==Number(key[n]))throw Error("CPF Pix inválido.");}
 }else throw Error("Escolha o tipo de chave Pix.");
 if(input.pix_owner!==true)throw Error("Confirme que a chave Pix pertence a você.");
 return {pix_type:type,pix_key:key,pix_holder:holder};
}
async function acceptance(req:Request,input:any){
 if(input.consent!==true||input.adult!==true||input.terms_version!==TERMS_VERSION)throw Error("Leia e aceite a versão atual dos termos e confirme que tem 18 anos ou mais.");
 const ip=req.headers.get("cf-connecting-ip")||req.headers.get("x-real-ip")||(req.headers.get("x-forwarded-for")||"").split(",")[0].trim();
 return {terms_version:TERMS_VERSION,terms_hash:TERMS_HASH,consent_at:new Date().toISOString(),consent_ip_hash:await sha256(ip+"|referral-acceptance|"),consent_user_agent:(req.headers.get("user-agent")||"").slice(0,500)};
}
async function getAdmin(req:Request){
 const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
 const {data,error}=await connection.auth.getUser(token);if(error||!data.user)return null;
 const {data:role,error:roleError}=await connection.from("user_roles").select("user_id").eq("user_id",data.user.id).eq("role","admin").maybeSingle();
 return !roleError&&role?data.user.id:null;
}

Deno.serve(async(req:Request)=>{
  const origin=req.headers.get("origin");
  if(req.method==="OPTIONS"){
    if(origin&&!allowedOrigins.has(origin))return answer(origin,403,{error:"Origem não autorizada."});
    return new Response(null,{status:204,headers:jsonHeaders(origin)});
  }
  if(req.method!=="POST")return answer(origin,405,{error:"Método não permitido."});
  if(origin&&!allowedOrigins.has(origin))return answer(origin,403,{error:"Origem não autorizada."});
  if(Number(req.headers.get("content-length")||0)>8000)return answer(origin,413,{error:"Dados excederam o limite."});
  let input:any;
  try{input=await req.json()}catch{return answer(origin,400,{error:"Envie um JSON válido."})}
  if(!input||typeof input!=="object")return answer(origin,400,{error:"Dados inválidos."});
  const action=String(input.action||"");
  try{
    if(action==="validate_code"){
      const code=String(input.code||"").trim().toUpperCase();
      const {data,error}=await connection.from("referral_partners").select("referral_code").eq("referral_code",code).eq("partner_status","active").eq("terms_version",TERMS_VERSION).maybeSingle();
      if(error)throw error;
      return answer(origin,200,{valid:!!data});
    }
    if(action.startsWith("admin_")){
      const admin=await getAdmin(req);if(!admin)return answer(origin,403,{error:"Acesso exclusivo do painel master."});
      if(action==="admin_list"){
        const page=Math.max(0,Math.min(100000,Number(input.page)||0));
        const {data,error,count}=await connection.from("referral_conversions").select("*,partner:referral_partners("+PARTNER_FIELDS+",terms_hash)",{count:"exact"}).order("created_at",{ascending:false}).range(page*50,page*50+49);
        if(error)throw error;
        const {data:partners,error:pe}=await connection.from("referral_partners").select(PARTNER_FIELDS).order("created_at",{ascending:false}).range(page*50,page*50+49);if(pe)throw pe;
        return answer(origin,200,{conversions:data,partners,total:count,page});
      }
      if(action==="admin_history"){
        const id=String(input.id||"");
        const {data:r,error:re}=await connection.from("referral_conversions").select("partner_id").eq("id",id).single();if(re)throw re;
        const {data:events,error:ee}=await connection.from("referral_audit").select("action,details,created_at,actor_id").eq("conversion_id",id).order("created_at");if(ee)throw ee;
        const {data:acceptances,error:ae}=await connection.from("referral_acceptances").select("terms_version,terms_hash,accepted_at").eq("partner_id",r.partner_id).order("accepted_at");if(ae)throw ae;
        return answer(origin,200,{events,acceptances});
      }
      if(action==="admin_transition"){
        if(input.confirmed!==true)return answer(origin,400,{error:"Confirme a conferência dos dados."});
        const {data,error}=await connection.rpc("referral_admin_transition",{p_id:input.id,p_actor:admin,p_action:input.transition,p_reference:input.reference||null,p_paid_at:input.paid_at||null,p_reason:input.reason||null,p_pix_key:input.pix_key||null});
        if(error)return answer(origin,400,{error:error.message});
        return answer(origin,200,{result:data});
      }
      return answer(origin,400,{error:"Ação inválida."});
    }
    if(action==="dashboard"||action==="update_profile"){
      const auth=await getPartner(req);if(!auth)return answer(origin,401,{error:"Sessão encerrada. Entre novamente."});
      if(action==="update_profile"){
        let patch:any;try{patch={...validatePix(input),...await acceptance(req,input)}}catch(e){return answer(origin,400,{error:(e as Error).message})}
        // Reauthenticate before changing financial details.
        const {data:secret,error:se}=await connection.from("referral_partners").select("password_salt,password_hash,password_iterations").eq("id",auth.partner.id).single();if(se)throw se;
        if(!constantTimeEqual(await derive(String(input.password||""),secret.password_salt,secret.password_iterations),secret.password_hash))return answer(origin,401,{error:"Senha atual incorreta. Os dados Pix não foram alterados."});
        const {data,error}=await connection.from("referral_partners").update({...patch,updated_at:new Date().toISOString()}).eq("id",auth.partner.id).select(PARTNER_FIELDS).single();if(error)throw error;
        return answer(origin,200,{partner:partnerView(data)});
      }
      const {data,error}=await connection.from("referral_conversions").select("id,shop_name,status,commission_cents,created_at,eligible_at,payout_due_at,paid_at,reason").eq("partner_id",auth.partner.id).order("created_at",{ascending:false}).limit(200);if(error)throw error;
      return answer(origin,200,{conversions:data,limit:200});
    }
    if(action==="me"){
      const auth=await getPartner(req);
      return auth?answer(origin,200,{partner:partnerView(auth.partner)}):answer(origin,401,{error:"Sessão encerrada. Entre novamente."});
    }
    if(action==="logout"){
      const auth=await getPartner(req);
      if(auth)await connection.from("referral_partner_sessions").update({revoked_at:new Date().toISOString()}).eq("id",auth.session.id);
      return answer(origin,200,{ok:true});
    }
    if(action!=="register"&&action!=="login")return answer(origin,400,{error:"Operação inválida."});
    const rawIP=req.headers.get("cf-connecting-ip")||req.headers.get("x-real-ip")||(req.headers.get("x-forwarded-for")||"").split(",")[0].trim()||"unknown";
    const iphash=await sha256(rawIP.slice(0,120)+"|central-indicacoes|"+action);
    const {count,error:limitErr}=await connection.from("referral_registration_attempts").select("id",{count:"exact",head:true}).eq("ip_hash",iphash).eq("action",action).gte("created_at",new Date(Date.now()-3600000).toISOString());
    if(limitErr)throw limitErr;
    if((count||0)>=(action==="register"?5:25))return answer(origin,429,{error:"Muitas tentativas. Tente novamente mais tarde."});
    const {error:attemptErr}=await connection.from("referral_registration_attempts").insert({ip_hash:iphash,action});
    if(attemptErr)throw attemptErr;
    const email=String(input.email||"").trim().toLowerCase();
    const password=String(input.password||"");
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return answer(origin,400,{error:"Informe um e-mail válido."});
    if(action==="register"){
      const full_name=String(input.name||"").trim().replace(/\s+/g," ");
      const cleaned=String(input.phone||"").replace(/\D/g,"");
      const phone=cleaned.startsWith("55")&&cleaned.length>=12?cleaned:"55"+cleaned;
      const consent=input.consent===true;
      if(full_name.length<3||full_name.length>120)return answer(origin,400,{error:"Informe seu nome completo."});
      if(!/^55[0-9]{10,11}$/.test(phone))return answer(origin,400,{error:"Informe um WhatsApp com DDD válido."});
      if(password.length<10||password.length>128)return answer(origin,400,{error:"Crie uma senha com 10 a 128 caracteres."});
      if(!consent)return answer(origin,400,{error:"É necessário aceitar os termos do programa."});
      let profile:any;try{profile={...validatePix(input),...await acceptance(req,input)}}catch(e){return answer(origin,400,{error:(e as Error).message})}
      const salt=randHex(20);
      const hash=await derive(password,salt);
      const {data:partner,error}=await connection.from("referral_partners").insert({full_name,email,phone,password_salt:salt,password_hash:hash,...profile}).select(PARTNER_FIELDS).single();
      if(error){
        if(error.code==="23505")return answer(origin,409,{error:"E-mail ou WhatsApp já cadastrado. Entre com sua conta."});
        throw error;
      }
      const session=await newSession(partner.id);
      return answer(origin,201,{partner:partnerView(partner),...session});
    }
    if(password.length>128)return answer(origin,401,{error:"E-mail ou senha incorretos."});
    const {data:partner,error}=await connection.from("referral_partners").select(PARTNER_FIELDS+",password_salt,password_hash,password_iterations").eq("email",email).maybeSingle();
    if(error)throw error;
    if(!partner)return answer(origin,401,{error:"E-mail ou senha incorretos."});
    const hash=await derive(password,partner.password_salt,partner.password_iterations);
    if(!constantTimeEqual(hash,partner.password_hash))return answer(origin,401,{error:"E-mail ou senha incorretos."});
    if(partner.partner_status!=="active")return answer(origin,403,{error:"Cadastro temporariamente indisponível. Fale com o suporte."});
    const session=await newSession(partner.id);
    return answer(origin,200,{partner:partnerView(partner),...session});
  }catch(e){
    console.error("referral-portal",e instanceof Error?e.message:String(e));
    return answer(origin,500,{error:"Não conseguimos concluir a solicitação. Tente novamente."});
  }
});
