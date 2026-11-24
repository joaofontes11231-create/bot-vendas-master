# Bot de vendas e hospedagem para Discord

Projeto Node.js com Discord.js, painel web Express e banco Turso/libSQL.

## O que existe hoje

- Loja por servidor Discord, com planos e cupons.
- Pedidos via PIX com confirmação manual pelo administrador.
- Cadastro e controle de hospedagens, renovação, suspensão e transferência.
- Painéis fixos no Discord e notificações de vencimento.
- Painel administrativo web com clientes, pedidos e exportação de backup.
- Persistência centralizada no Turso.

## Requisitos

- Node.js 20 ou superior.
- Uma aplicação Turso/libSQL.
- Uma aplicação/bot criado no Discord Developer Portal.
- Um único processo da aplicação em execução por vez.

## Configuração

Copie `.env.example` para `.env` localmente e preencha os valores. Nunca publique o arquivo `.env`.

| Variável | Obrigatória | Finalidade |
| --- | --- | --- |
| `DISCORD_TOKEN` | Sim | Token privado do bot Discord |
| `CLIENT_ID` | Sim para registrar comandos | ID da aplicação Discord |
| `MASTER_ID` | Sim | ID Discord do administrador principal |
| `REGISTER_COMMANDS` | Não | Use `true` para registrar/atualizar comandos globais |
| `TURSO_DATABASE_URL` | Sim | URL do banco Turso |
| `TURSO_AUTH_TOKEN` | Sim | Token de autenticação do Turso |
| `MASTER_PASSWORD` | Sim | Senha do painel web |
| `SESSION_SECRET` | Recomendado | Segredo persistente de sessões do painel |
| `NODE_ENV` | Recomendado | Defina `production` em produção |
| `PORT` | Não | Porta HTTP; a plataforma pode defini-la automaticamente |

Gere um segredo de sessão forte com:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Configure esse valor como `SESSION_SECRET` nas variáveis do Railway ou Render. Em produção, use pelo menos 32 caracteres aleatórios e uma `MASTER_PASSWORD` com pelo menos 12 caracteres; o servidor agora recusa iniciar em produção se esses requisitos não forem atendidos. As sessões usam cookie HTTP-only, Secure em HTTPS e SameSite Strict.

## Executar localmente

```bash
npm install
npm test
npm start
```

O banco e suas migrações são inicializados antes de o site e o bot começarem.

## Deploy

O ponto de entrada suporta três perfis por meio de `APP_ROLE`:

- `all` (padrão): inicia site e bot no mesmo processo. Use em apenas uma plataforma.
- `web`: inicia somente o painel web. Use em um serviço Web do Render.
- `bot`: inicia somente o worker Discord e as tarefas agendadas. Use em um serviço Worker do Railway.

### Opção A — mais simples: uma plataforma

1. Publique como um serviço contínuo no Railway **ou** no Render.
2. Configure `APP_ROLE=all` (ou deixe sem definir), todas as variáveis e `npm start`.
3. Configure o health check HTTP em `/health`.
4. Mantenha apenas uma instância.

### Opção B — Render + Railway separados

**Render (Web Service):**
- Build command: `npm ci`
- Start command: `npm start`
- Variáveis: `APP_ROLE=web`, `NODE_ENV=production`, `MASTER_PASSWORD`, `SESSION_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
- Health check path: `/health`.

**Railway (Worker Service):**
- Build command: `npm ci`
- Start command: `npm start`
- Variáveis: `APP_ROLE=bot`, `DISCORD_TOKEN`, `CLIENT_ID`, `MASTER_ID`, `REGISTER_COMMANDS=true` (na primeira publicação/ao alterar comandos), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
- Não configure réplicas maiores que 1 para o worker: ele executa tarefas periódicas.

Ambos usam o mesmo banco Turso, mas funções separadas. Nunca use `APP_ROLE=all` nos dois serviços ao mesmo tempo, pois isso duplica o bot e os workers. Depois que os comandos globais forem registrados, pode definir `REGISTER_COMMANDS=false`; mudanças nos slash commands exigem novo registro.

O deploy de um serviço não reinicia o outro. Uma atualização do código do bot só chega ao Discord quando o serviço `bot` no Railway (ou o serviço `all` escolhido) for implantado e reconectar. Os comandos slash são atualizados pelo Discord quando `REGISTER_COMMANDS=true`; comandos globais podem levar algum tempo para aparecer em todos os clientes.


## Mercado Pago por loja (OAuth)

Cada loja tem uma conexão Mercado Pago independente. O responsável da loja abre `/seller/ID_DO_SERVIDOR`, autentica com a conta Discord que consta como proprietária e escolhe **Conectar Mercado Pago**. A autorização usa OAuth Authorization Code + PKCE; os access/refresh tokens são armazenados criptografados com AES-256-GCM no Turso. A senha do vendedor nunca é solicitada pelo bot.

### Variáveis adicionais

Configure no **Render e no Railway** as mesmas variáveis de integração para que o painel e o worker possam acessar/renovar as conexões:

- `MP_CLIENT_ID` e `MP_CLIENT_SECRET`: credenciais da aplicação Mercado Pago do marketplace.
- `MP_REDIRECT_URI`: URL fixa do callback, exatamente igual à cadastrada na aplicação Mercado Pago, por exemplo `https://SEU-DOMINIO/oauth/mercadopago/callback`.
- `MP_TOKEN_ENCRYPTION_KEY`: chave aleatória de 32 bytes para criptografar tokens. Gere uma vez com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` e use o mesmo valor nos dois serviços. Nunca troque sem migrar/recriptografar os tokens já salvos.
- `PUBLIC_BASE_URL`: URL HTTPS pública do Render, sem barra final.
- `MP_MODE`: `test` durante homologação ou `production` para pagamentos reais.
- `MP_WEBHOOK_SECRET`: assinatura secreta de Webhooks da aplicação Mercado Pago; necessária no Render.
- `DISCORD_CLIENT_SECRET` e `DISCORD_REDIRECT_URI`: login OAuth Discord do portal do lojista. Cadastre o callback exato na aplicação Discord.

No Render, configure também `APP_ROLE=web`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `MP_WEBHOOK_SECRET` e `MP_MODE`. No Railway, configure `APP_ROLE=bot` e as credenciais Mercado Pago/criptografia/URL pública compartilhadas. O worker não precisa do segredo de webhook nem do segredo OAuth Discord.

### Configuração externa obrigatória

1. Cadastre os callbacks OAuth exatos nas aplicações Discord e Mercado Pago.
2. Habilite PKCE para o fluxo Authorization Code na aplicação Mercado Pago.
3. Configure Webhooks de pagamento da aplicação Mercado Pago para `https://SEU-DOMINIO/webhooks/mercadopago` e selecione eventos de criação/atualização de pagamentos.
4. Use contas de teste e `MP_MODE=test` primeiro. Só habilite `MP_MODE=production` depois de homologar todos os fluxos.
5. Cada conta recebedora deve pertencer ao responsável adulto da respectiva loja e concluir os requisitos de cadastro/verificação do Mercado Pago.

O callback de retorno do checkout não aprova pedidos. A liberação só acontece após validar assinatura do webhook, conta recebedora, ID da preferência, referência externa, valor e moeda consultados diretamente na API do Mercado Pago. Pedidos Mercado Pago não podem ser aprovados manualmente antes da confirmação. Atualizações posteriores de pagamento (estorno, chargeback ou cancelamento) são registradas no histórico de auditoria para revisão do responsável; a suspensão automática da hospedagem e a execução de estornos ainda exigem um fluxo operacional próprio.

**Importante:** o backup JSON não exporta as conexões nem os tokens Mercado Pago. A chave `MP_TOKEN_ENCRYPTION_KEY` deve ser guardada fora do repositório e com backup seguro; perder essa chave impede descriptografar conexões existentes.

## Rotas web

- `/health`: health check simples do processo web.
- `/status`: página pública de status.
- `/login`: autenticação do painel master.
- `/`: painel administrativo, após login.
- `/api/backup`: exportação JSON protegida por autenticação.

As sessões usam cookie HTTP-only e SameSite, o login tem limite local de tentativas e a sessão é regenerada após autenticação. O armazenamento de sessão padrão do express-session fica em memória; sessões não sobrevivem a reinícios e não são compartilhadas entre várias instâncias. Para produção com múltiplas instâncias, configure um session store persistente antes de escalar horizontalmente.

## Pagamentos: limitação atual

O fluxo atualmente gera pedidos PIX e registra-os como pendentes. A liberação da hospedagem acontece quando o administrador confirma o recebimento manualmente por `/painel_dono aprovar_pedido` ou pelo painel web.

Embora a dependência `mercadopago` esteja no `package.json`, o código atual não contém integração de API/webhook do Mercado Pago nem confirmação automática do PIX. **Não anuncie pagamentos ou entregas como automáticos até implementar e testar a confirmação assinada do provedor**, com idempotência e tratamento de eventos repetidos.

## Cuidados antes de produção

- Faça backup do Turso antes de publicar migrações.
- Mantenha tokens e senhas apenas nas variáveis de ambiente.
- Use HTTPS na plataforma de hospedagem.
- Teste compra, aprovação, renovação, suspensão, DM fechada e falha de banco em um servidor de testes.
- Confirme manualmente os dados de pagamentos antes de aprovar pedidos.
- Não compartilhe dados de acesso do cliente em canais públicos.
- O painel fixo do cliente não deve exibir credenciais; ele informa que os dados são enviados somente por DM. Após atualizar a versão, remova painéis antigos não registrados e, se alguma credencial já apareceu em canal público, troque-a.

## Verificação disponível

`npm test` executa verificações de regressão estáticas para invariantes de segurança e valida a sintaxe dos quatro arquivos JavaScript principais. O GitHub Actions também testa Node.js 20 e 22 e executa `npm audit --omit=dev --audit-level=high`. Isso não substitui testes de integração com Discord, Turso ou o provedor de pagamentos.
