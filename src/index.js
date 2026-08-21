require('./polyfills');
require('dns').setDefaultResultOrder('ipv4first');

const { Client } = require('discord.js-selfbot-v13');
const config = require('./config');
const { log } = require('./logger');
const db = require('./database');
const state = require('./state');
const { verificarLicenca } = require('./services/license');
const { iniciarGmailMonitor } = require('./services/gmailPixService');
const { ligarTelegram } = require('./services/telegram');
const { registrarWebhookListener } = require('./services/webhook');
const { iniciarDashboard } = require('./dashboard/routes');
const threadCreateHandler = require('./discord/events/threadCreate');
const messageCreateHandler = require('./discord/events/messageCreate');
let goCommandService = null;
try { goCommandService = require('./services/goCommandService'); } catch (_) { }

const { TIMINGS } = state;

const client = new Client({
    checkUpdate: false,
    messageCacheMaxSize: 10,
    messageCacheLifetime: 120,
    messageSweepInterval: 60,
});

iniciarDashboard(client);

threadCreateHandler.registrar(client);
messageCreateHandler.registrar(client);

// gc periodico
setInterval(() => {
    const agora = Date.now();

    const removidosP = state.pagamentosRecentes.purge();

    const filasParaDeletar = [];
    for (const [threadId, fila] of state.filasPagamento) {
        const idade = agora - (fila.criadaEm || 0);
        const ehVelha = idade > TIMINGS.FILA_MAX_AGE_MS;
        const ehFinalizada = fila.salaCriada && idade > TIMINGS.FILA_DONE_MAX_AGE_MS;

        if (ehVelha || ehFinalizada) {
            filasParaDeletar.push(threadId);
        }
    }
    for (const threadId of filasParaDeletar) {
        const fila = state.filasPagamento.get(threadId);
        if (fila) {
            if (fila.confirmados) fila.confirmados.clear();
            if (fila.pagamentosUsados) fila.pagamentosUsados.length = 0;
        }
        state.filasPagamento.delete(threadId);
    }

    const removidosT = state.threadsAguardandoSala.purge();

    const goParaDeletar = [];
    for (const [threadId, sala] of state.salasAguardandoGo) {
        if (agora - sala.criadoEm > 30 * 60 * 1000) {
            goParaDeletar.push(threadId);
        }
    }
    for (const threadId of goParaDeletar) {
        const sala = state.salasAguardandoGo.get(threadId);
        if (sala && sala.jogadoresConfirmados) sala.jogadoresConfirmados.clear();
        state.salasAguardandoGo.delete(threadId);
    }

    if (goCommandService) {
        try { goCommandService.limparSalasExpiradas(); } catch (_) { }
    }

    const removidosUsados = state.pagamentosRecentes.removeWhere(p =>
        p.filaUsada && (agora - p.horario) > TIMINGS.PGTO_USADO_MAX_AGE_MS
    );

    if (removidosP + removidosUsados > 0) {
        state.limparIndicePagamentos();
    }

    const rlParaDeletar = [];
    for (const [chId, reg] of state._rateLimitMap) {
        reg.msgs = reg.msgs.filter(ts => (agora - ts) < TIMINGS.RATE_LIMIT_WINDOW_MS);
        if (reg.msgs.length === 0) rlParaDeletar.push(chId);
    }
    for (const chId of rlParaDeletar) state._rateLimitMap.delete(chId);

    const tfParaDeletar = [];
    for (const [key, val] of state.tentativasFalhas) {
        if (val && val.ts && (agora - val.ts) > 5 * 60 * 1000) tfParaDeletar.push(key);
    }
    for (const key of tfParaDeletar) state.tentativasFalhas.delete(key);

    try {
        if (client.guilds?.cache) {
            client.guilds.cache.forEach(guild => {
                if (guild.members?.cache?.size > 50) {
                    guild.members.cache.sweep(m => m.id !== client.user.id);
                }
                if (guild.presences?.cache?.size > 0) {
                    guild.presences.cache.clear();
                }
            });
        }
    } catch (_) { }

    const timersAtivos = state.getActiveTimerCount();
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalRemovido = removidosP + filasParaDeletar.length + removidosT + removidosUsados + goParaDeletar.length + rlParaDeletar.length;

    log('', `Heap: ${heapMB}MB | ` +
        `Filas: ${state.filasPagamento.size} | Pgtos: ${state.pagamentosRecentes.length} | ` +
        `GO: ${state.salasAguardandoGo.size} | Timers: ${timersAtivos}` +
        (totalRemovido > 0
            ? ` | ️ ${totalRemovido} limpezas`
            : ''));

    if (global.gc) global.gc();

    if (heapMB > TIMINGS.HEAP_CRITICO_MB) {
        log('', `MEMÓRIA CRÍTICA: ${heapMB}MB! Limpeza de emergência...`);
        state.pagamentosRecentes.purge();
        state.mensagensProcessadas.clear();
        state.threadsRespondidas.clear();
        state.usuariosProcessando.clear();
        state._rateLimitMap.clear();
        state.tentativasFalhas.clear();

        const emergencia = [];
        for (const [tid, fila] of state.filasPagamento) {
            if (fila.salaCriada) emergencia.push(tid);
        }
        for (const tid of emergencia) state.filasPagamento.delete(tid);

        try {
            client.guilds?.cache?.forEach(g => {
                g.members?.cache?.sweep(m => m.id !== client.user.id);
                g.presences?.cache?.clear();
            });
        } catch (_) { }

        if (global.gc) global.gc();
    }
}, TIMINGS.GC_INTERVAL_MS);

// boot
client.once('ready', async () => {
    const liberado = await verificarLicenca();
    if (!liberado) return;

    log('🟢', `Discord: Bot conectado como ${client.user.username}`);
    state.statusConexoes.discord = true;
    state.discordClient = client;
    if (state.io) state.io.emit('status', state.statusConexoes);

    await db.inicializar().catch(err => {
        log('', `Falha ao inicializar banco de dados: ${err.message}`);
    });

    const autoResponder = require('./services/autoResponder');
    autoResponder.carregarRegras();

    const serverRules = require('./services/serverRules');
    serverRules.carregarRegras();

    await db.restaurarPagamentosPendentes(state).catch(err => {
        log('️', `Falha ao restaurar pagamentos pendentes: ${err.message}`);
    });

    if (config.discord.canalWebhookId) {
        registrarWebhookListener(client);
    }

    iniciarGmailMonitor();
    ligarTelegram(client);

    log('', 'Gmail API Monitor ativo — vigiando e-mails de PIX.');
});

// error handling
process.on('uncaughtException', (err) => {
    log('', `Erro capturado: ${err.message}`);
    if (err.stack) console.log(err.stack);
});

process.on('unhandledRejection', (err) => {
    log('', `Rejeição capturada: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.log(err.stack);
});

// login
client.login(config.discord.token).catch(err => {
    log('', `Erro ao fazer login no Discord: ${err.message}`);
    if (err.stack) console.log(err.stack);
});