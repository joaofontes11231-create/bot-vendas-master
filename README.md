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

Configure esse valor como `SESSION_SECRET` nas variáveis do Railway ou Render. Sem ele, o sistema gera um segredo aleatório a cada inicialização e as sessões serão encerradas quando o processo reiniciar.

## Executar localmente

```bash
npm install
npm test
npm start
```

O banco e suas migrações são inicializados antes de o site e o bot começarem.

## Deploy

O ponto de entrada `index.js` inicia **o bot Discord e o site no mesmo processo**. Portanto:

1. Publique este projeto como um único serviço contínuo no Railway **ou** no Render.
2. Configure todas as variáveis de ambiente na plataforma.
3. Use o comando de inicialização `npm start`.
4. Configure o health check HTTP para `/health`, na porta disponibilizada por `PORT`.
5. Mantenha apenas uma instância desse processo enquanto o bot não tiver coordenação distribuída/leader election.

**Não rode o mesmo `npm start` simultaneamente no Railway e no Render.** Isso criaria duas instâncias do mesmo bot e poderia duplicar tarefas agendadas e mensagens. Para separar bot e site em serviços diferentes, primeiro será necessário separar os processos e adicionar controle de execução das tarefas.

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

## Verificação disponível

`npm test` verifica a sintaxe dos quatro arquivos JavaScript principais. Isso não substitui testes de integração com Discord, Turso ou o provedor de pagamentos.
