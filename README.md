# Discord Room and Payment Bot

Este é um bot multifuncional para Discord e Telegram, projetado para gerenciar a criação de salas e verificar o recebimento de pagamentos via Pix.

## Recursos
- **Integração com Telegram**: Usa o Telegram para automatizar comandos e ações de criação de salas.
- **Gerenciamento de Salas (Painel)**: Criação, gestão de modo de jogo e confirmação (ready).
- **Leitor de Pix (Gmail + OCR)**: Lê comprovantes e mensagens do Gmail para reconhecer transferências recebidas.
- **Webhook e Auto Responder**: Monitora canais do Discord e responde a eventos (criação de threads e mensagens).
- **Dashboard/API Local**: Fornece endpoints via Express para verificar status e saúde da aplicação.

## Requisitos
- Node.js (v18+)
- Conta no Discord (Token de Automação para SelfBot ou Bot padrão compatível com `discord.js-selfbot-v13`)
- Conta/Sessão do Telegram (String Session para `telegram` lib)
- API do Gmail configurada (Client ID, Secret, Refresh Token)
- (Opcional) Chave da API do OCR.space

## Variáveis de Ambiente (`.env`)
Você precisa configurar um arquivo `.env` na raiz do projeto contendo as seguintes variáveis de configuração:

```ini
# Discord
DISCORD_TOKEN=seu_token_discord
GUILD_ID=id_do_servidor
ADMIN_ID=id_do_admin
CHANNEL_LOGS=id_do_canal_logs
CATEGORY_TICKETS=id_da_categoria_tickets

# Telegram
TELEGRAM_API_ID=sua_api_id
TELEGRAM_API_HASH=seu_api_hash
TELEGRAM_SESSION=sua_session_string
TELEGRAM_TARGET=nome_ou_id_do_bot_alvo

# Gmail
GMAIL_CLIENT_ID=seu_client_id
GMAIL_CLIENT_SECRET=seu_client_secret
GMAIL_REFRESH_TOKEN=seu_refresh_token

# Outros
PORT=3000
OCR_API_KEY=sua_chave_ocr
```

## Como rodar
1. Instale as dependências:
   ```bash
   npm install
   ```
2. Crie e preencha o arquivo `.env`.
3. Inicie o bot:
   ```bash
   node src/index.js
   ```

## Comandos Disponíveis
- `!sala [id] [senha]` - Força a inicialização ou formatação de uma sala para o canal atual.
- `.go [id]` - O usuário interage confirmando participação em uma sala específica.
- `+cs [modo]` (No telegram) - Comando rápido de criação (suporta `+cs 2` e `+cs 3`).

## Problemas Comuns
- **Erro de Conexão com Telegram**: O bot tem delays progressivos de reconexão. Se a string session for inválida, ele não vai conectar.
- **Gmail não extraindo nomes**: Se o email do Pix vier em um formato novo ou HTML muito complexo, o parser pode falhar, mas ele cairá no fallback para procurar anexos e ler por OCR.
- **Limites de RAM**: O Bot usa estruturas próprias `BoundedMap` e `BoundedSet` para não estourar os 512MB de memória. Evite modificar a lógica de limpeza de estado se não tiver certeza.
