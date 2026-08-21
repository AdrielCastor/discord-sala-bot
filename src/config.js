require('dotenv').config();

function requiredEnv(name) {
    const val = process.env[name];
    if (!val) {
        console.error(` ERRO FATAL: Variável de ambiente '${name}' não definida no .env!`);
        process.exit(1);
    }
    return val;
}

module.exports = {
    discord: {
        token: requiredEnv('DISCORD_TOKEN'),
        logChannelId: process.env.LOG_CHANNEL_ID || '',
        cargoMediadorId: process.env.CARGO_MEDIADOR_ID || '1420187388327497751',
        canalWebhookId: process.env.CANAL_WEBHOOK_ID || '',
        guildId: process.env.GUILD_ID || '',
    },
    email: {
        usuario: process.env.EMAIL_USUARIO || '',
        senha: process.env.EMAIL_SENHA || '',
    },
    pix: {
        chave: requiredEnv('MINHA_CHAVE_PIX'),
        nome: requiredEnv('MEU_NOME_PIX'),
    },
    gmail: {
        clientId: process.env.GMAIL_CLIENT_ID || '',
        clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
        refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    },
    telegram: {
        apiId: Number(process.env.TELEGRAM_API_ID) || 0,
        apiHash: process.env.TELEGRAM_API_HASH || '',
        chaveMestra: process.env.TELEGRAM_CHAVE_MESTRA || '',
        alvo: process.env.TELEGRAM_ALVO || '',
    },
    licenca: process.env.LICENCA || 'NENHUMA_KEY_INSERIDA',
    dashboardPort: Number(process.env.DASHBOARD_PORT) || 80,
};
