# Central de Indicações — Ponto Zero

Aplicação pública independente para divulgação dos sistemas (Agende Barber, Zappi Food, Finança Exata e futuros produtos).

## Status atual
- Portal institucional responsivo e páginas de divulgação.
- Geração local de URLs por código fornecido pela equipe; redirecionamento com `ref` e UTM.
- Registro de indicadores e validação de comissões **ainda não automatizados**. O portal deixa isso explícito.
- Valores: Agende Barber R$ 15 somente por primeira assinatura confirmada. Demais sistemas a definir.
- O formulário de adesão abre WhatsApp da equipe, não há cadastro em banco.

## Para ativar o programa completo com segurança
1. Usar banco/identidade de autenticação **separados** dos sistemas comerciais. O Supabase do Agende Barber possui triggers na tabela `auth.users` e não deve ser usado para criar indicadores de outros produtos.
2. Criar `referral_programs`, `referral_partners`, `referral_leads`, `referral_conversions`, `referral_payouts` e trilha de auditoria com RLS e acesso master.
3. Registrar o código da indicação na criação do assinante em **cada SaaS**, validar evento real do primeiro pagamento, manter idempotência de webhooks e impedir duplicidade/autorreferência.
4. Tela segura do master para aprovar/conferir pagamentos Pix (nunca aprovar só por clique ou cadastro).
5. Configurar domínio próprio no DNS caso seja desejado (Vercel fornece URL .vercel.app).
6. Confirmar landing URL de Finança Exata antes de ativar seu redirecionamento.
7. Validar consentimento/LGPD, titularidade da chave Pix, cancelamentos/estornos, limite de comissão.

Não contém credenciais nem segredos.