import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const allowedOrigins = new Set([
  "https://central-indicacoes.vercel.app",
  "https://central-indicacoes-dflimairatis-projects.vercel.app",
  "https://indicacoes.agendebarber.com",
]);
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
  return {name:p.full_name,email:p.email,phone:p.phone,code:p.referral_code,status:p.partner_status,created_at:p.created_at};
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
  const {data:partner}=await connection.from("referral_partners").select("id,full_name,email,phone,referral_code,partner_status,created_at").eq("id",session.partner_id).maybeSingle();
  return partner&&partner.partner_status==="active"?{partner,session}:null;
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
      const salt=randHex(20);
      const hash=await derive(password,salt);
      const {data:partner,error}=await connection.from("referral_partners").insert({full_name,email,phone,password_salt:salt,password_hash:hash,consent_at:new Date().toISOString()}).select("id,full_name,email,phone,referral_code,partner_status,created_at").single();
      if(error){
        if(error.code==="23505")return answer(origin,409,{error:"E-mail ou WhatsApp já cadastrado. Entre com sua conta."});
        throw error;
      }
      const session=await newSession(partner.id);
      return answer(origin,201,{partner:partnerView(partner),...session});
    }
    if(password.length>128)return answer(origin,401,{error:"E-mail ou senha incorretos."});
    const {data:partner,error}=await connection.from("referral_partners").select("id,full_name,email,phone,referral_code,partner_status,created_at,password_salt,password_hash,password_iterations").eq("email",email).maybeSingle();
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
