# MPS Kings: site com termos, perfil e Support

O que o site faz:

- **Login com Discord**: quem abre o site vê só os termos e o botão **Conectar com Discord** (conectar vale como concordar). O Discord confirma o usuário e a foto (OAuth, escopo `identify`) e a pessoa já entra com isso, sem digitar nick nenhum.
- **Welcome back**: a Home mostra o usuário e a foto do Discord da pessoa.
- **My Profile**: foto e usuário do Discord. O nick do Roblox é opcional: a pessoa adiciona ali e o site traz ID e foto do Roblox.
- **Support**: qualquer membro abre tickets e conversa com a Staff. O Discord (e o Roblox, se informado) vai junto automaticamente.
- **Staff**: botão que pede a senha da Staff. Quem entra vê todos os tickets numa lista, com o nick e o ID do Roblox e o nick do Discord de cada pessoa, e responde como numa conversa.
- **Links**: abre https://linktr.ee/MPSKings.

O login com Discord é a única forma de os membros entrarem (veja abaixo). Não precisa instalar pacote. O servidor usa só o Node (versão 18 ou mais nova).

---

## Colocar no ar (exemplo com Render)

1. Crie um repositório no GitHub e envie estes arquivos (menos as pastas `node_modules` e `data`, se existirem).
2. Em https://render.com, clique em **New** e depois **Web Service**, e escolha o repositório.
3. Preencha:
   - **Runtime**: Node
   - **Build Command**: deixe vazio (ou `echo ok`)
   - **Start Command**: `npm start`
4. Em **Environment**, adicione as variáveis:

| Variável | Valor |
| --- | --- |
| `BASE_URL` | O endereço final do site, com `https://` e sem barra no fim. Ex.: `https://mpskings.onrender.com` |
| `SESSION_SECRET` | Um texto longo e aleatório. Para gerar: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `STAFF_PASSWORD` | `EREMITA` (a senha do botão Staff) |
| `DISCORD_CLIENT_SECRET` | o Client Secret do seu app no Discord (obrigatória: sem ela os membros não conseguem entrar) |
| `DISCORD_BOT_TOKEN` | opcional: token do bot do seu app (aba Bot), que precisa estar dentro do servidor. É só para ler o nome e a cor dos cargos; sem ele o perfil mostra "Cargos indisponíveis" |
| `DISCORD_CLIENT_ID` | opcional; já vem `1559004196303278140` |
| `DATA_DIR` | Pasta do disco persistente (veja abaixo). Ex.: `/var/data` |

5. Clique em **Create Web Service**. Quando terminar, abra o endereço e teste: conecte com o Discord, abra um ticket, depois saia e entre pelo botão **Staff**.

### Importante: onde os dados ficam

Usuários e tickets ficam num arquivo (`db.json`) dentro de `DATA_DIR`. Se o serviço rodar num disco temporário, **tudo some a cada novo deploy ou reinício**. Use um disco persistente. No Render, disco persistente é recurso de plano pago. No Railway existe o recurso Volume. Monte o disco numa pasta (ex.: `/var/data`) e coloque o mesmo caminho em `DATA_DIR`. Faça cópia do `db.json` de vez em quando.

## Testar no seu computador

1. Instale o Node 20.6 ou mais novo.
2. Copie `.env.example` para `.env` e cole o Client Secret do Discord em `DISCORD_CLIENT_SECRET` (o servidor lê esse arquivo sozinho; ele nunca vai para o GitHub). Já vem com `STAFF_PASSWORD=EREMITA`.
3. Rode `npm run dev` e abra http://localhost:3000.

`npm test` roda uma verificação automática do servidor com o Roblox simulado.

## Como funciona e limites

- **O Roblox não é verificado como sendo da pessoa.** O usuário precisa existir, mas alguém pode informar o nick de outra pessoa. O Discord, esse sim, é confirmado pelo login.
- **Quem entra de outro aparelho** continua com a mesma conta e os tickets, porque o Discord identifica a pessoa. Sem o login do Discord ninguém entra como membro.
- **A senha da Staff é uma só.** Quem souber a senha vê todos os tickets de todos. Para trocar, mude `STAFF_PASSWORD` e reinicie o serviço. A senha não diferencia maiúsculas de minúsculas. Ela fica só na variável do servidor, não no código do site. Depois de 8 tentativas erradas em 10 minutos, o IP é bloqueado por um tempo.
- **Limites por segurança:** 20 ações por minuto por pessoa, 10 cadastros por hora por IP, no máximo 10 tickets abertos por membro, mensagens de até 2000 caracteres.
- **Privacidade:** o servidor guarda o ID, o usuário e a foto do Discord, o nick e o ID do Roblox (se a pessoa informar), a data em que a pessoa concordou com os termos e os tickets. Não guarda e-mail.

## Estrutura

- `server.js`: servidor (entrada, perfil, Staff, tickets)
- `public/`: o site (`index.html`, `style.css`, `app.js`, `logo.png`, `hero.jpg`). Para trocar o fundo do Welcome back, substitua `public/hero.jpg`.
- `test/smoke.js`: teste automático

## Login com Discord (OAuth)

1. No [Discord Developer Portal](https://discord.com/developers/applications), abra o seu app, vá em **OAuth2** e, em **Redirects**, adicione exatamente `SEU_BASE_URL/auth/discord/callback` (por exemplo `https://mpskings.onrender.com/auth/discord/callback`). O link `discord.gg/...` **não serve** como redirect: o Discord mandaria a pessoa para o convite e o código de login nunca chegaria no site.
2. Copie o **Client Secret** (OAuth2 > Client Secret) para a variável `DISCORD_CLIENT_SECRET` na hospedagem. Nunca coloque o segredo no código nem mande para ninguém.
3. Pronto: o botão da tela de termos, **Conectar com Discord**, leva ao login do Discord. O site confirma o nome de usuário e a foto do Discord (escopos `identify` e `guilds.members.read`, sem e-mail), entra direto com essa foto e esse nome (o nick do Roblox é opcional e se adiciona em My Profile). Quem voltar com o Discord, de qualquer aparelho, recupera a mesma conta e os tickets.

O Welcome back mostra o **apelido da pessoa no servidor** do Discord (ID `1531329234105139331`, mude com `DISCORD_GUILD_ID`). Se ela não estiver no servidor ou não tiver apelido, aparece o nome de usuário.

No **My Profile** aparecem o usuário do Discord, o apelido no servidor e os cargos dele (bolinha na cor do cargo e o nome em uma caixa). Os cargos são lidos no momento do login. O topo da página mostra o usuário (nick), e só o Welcome back usa o apelido.

## Anúncios, Staff Setup e cores

- **Anúncios:** aba para todos os membros lerem os avisos da Staff. Aparece uma bolinha na aba quando há anúncio novo, e o anúncio ainda não lido fica com a marca "Novo".
- **Staff Setup:** quem entra pelo botão **Staff** ganha o botão extra **Staff Setup**, onde publica e apaga anúncios.
- **Cores do site:** em My Profile cada pessoa escolhe um tema (Padrão, Azul, Roxo, Verde, Vermelho ou Dourado). A escolha fica salva na conta e também no navegador.
