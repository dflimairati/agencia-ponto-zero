# Indique & Ganhe — Agende Barber

Exclusivo do Agende Barber. Portal estático em `indicacoes.agendebarber.com`, função `referral-portal` no Supabase do Agende Barber. Parceiros têm sessões próprias (não são criados em auth.users).

## Fluxo
- Cadastro gratuito com Pix, maioridade e aceite explícito da versão `AB-2026-10-19.1`.
- Link pessoal leva a `/cadastro-barbearia?ref=CODIGO`. O cadastro envia `referral_code`; trigger após INSERT de barbearia registra uma conversão única por barbearia/responsável.
- O código é informação de atribuição; nunca concede autorização. Cadastro sem código não gera comissão retroativa automaticamente.
- Master: `/admin?tab=referrals` → conferir comprovante da primeira mensalidade → espera de 7 dias → aprovar → transferir Pix externamente → registrar comprovante único.
- R$15 uma vez; prazo de até 10 dias úteis após liberação. Cálculo conservador exclui fins de semana; não posterga por feriados.
- Pix não é automático. Liberar uma assinatura/loja não é comprovação de recebimento. Descontos exigem conferência de elegibilidade.
- Transferências são registradas atomicamente com trava e histórico. Estorno registrado não debita conta bancária.
- Dados financeiros e termos ficam em tabelas sem grants a anon/authenticated. A função valida sessão de parceiro ou JWT + papel admin do banco.
- Parceiro só vê suas indicações. Master vê contato, Pix, barbearia, status e histórico do aceite.
- Termos em `terms.txt` / `termos.html`, versão e SHA-256 persistidos. Novo texto exige nova versão e novo aceite. Não alterar texto de uma versão já aceita.

## Banco e testes
`database/referrals_v2.sql`: migração aplicada via Supabase em 19/10/2026 UTC.
`database/referrals_v2_test.sql`: testes transacionais com rollback para vínculo, aceite, bloqueio de 7 dias, Pix alterado, duplicidade, autorização, auditoria e imutabilidade do vínculo.

## Pontos operacionais
- Conferir titularidade no banco: validar o formato de Pix não consulta o Banco Central.
- Revisar o regulamento juridicamente e manter identificação/contato do responsável atualizados.
- Atendimento e recuperação de conta pelo suporte. Nenhuma senha bancária é coletada.
- Interface lista 50 registros por página no master; parceiro lista 200 mais recentes.
