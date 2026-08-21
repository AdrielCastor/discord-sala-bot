const express = require('express');
const http = require('http');
const path = require('path');
const { Server: SocketServer } = require('socket.io');
const config = require('../config');
const { log, getRecentLogs } = require('../logger');
const state = require('../state');
const db = require('../database');

let _gmailService = null;
let _telegramModule = null;
function getGmailService() { if (!_gmailService) try { _gmailService = require('../services/gmailPixService'); } catch (_) {} return _gmailService; }
function getTelegramModule() { if (!_telegramModule) try { _telegramModule = require('../services/telegram'); } catch (_) {} return _telegramModule; }

const DASH_USER = process.env.DASH_USER || 'cliente';
const DASH_PASS = process.env.DASH_PASS || 'salvesalas06';

function iniciarDashboard(client) {
    const app = express();
    const server = http.createServer(app);
    const io = new SocketServer(server, { cors: { origin: '*' } });
    state.io = io;

    app.use((req, res, next) => {
        if (req.path === '/health' || req.path === '/ping') return next();
        if (!req.path.startsWith('/api')) return next();

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Basic ')) {
            return res.status(401).json({ error: 'Autenticação necessária.' });
        }

        const base64 = authHeader.split(' ')[1];
        const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');

        if (user !== DASH_USER || pass !== DASH_PASS) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }

        next();
    });

    io.use((socket, next) => {
        const { user, pass } = socket.handshake.auth || {};
        if (user === DASH_USER && pass === DASH_PASS) return next();

        const authHeader = socket.handshake.headers?.authorization;
        if (authHeader && authHeader.startsWith('Basic ')) {
            const base64 = authHeader.split(' ')[1];
            const [u, p] = Buffer.from(base64, 'base64').toString().split(':');
            if (u === DASH_USER && p === DASH_PASS) return next();
        }

        return next();
    });

    io.on('connection', (socket) => {
        const recentLogs = getRecentLogs();
        if (recentLogs.length > 0) socket.emit('logs-iniciais', recentLogs);
        socket.emit('status', state.statusConexoes);
        socket.emit('bot-status', { rodando: state.botRodando });
    });

    app.use(express.static(path.join(process.cwd(), 'dashboard')));
    app.use(express.json());

    app.get('/api/auth/check', (req, res) => {
        res.json({ ok: true, user: DASH_USER });
    });


    app.get('/api/licenca', (req, res) => {
        res.json(state.licencaInfo);
    });

    app.post('/api/bot/parar', async (req, res) => {
        if (!state.botRodando) {
            return res.json({ ok: true, mensagem: 'Bot já está parado.' });
        }

        try {
            state.botRodando = false;
            log('', '[DASHBOARD] Bot PARADO pelo painel de controle.');

            try {
                if (client) {
                    client.destroy();
                    state.statusConexoes.discord = false;
                    log('', '[DASHBOARD] Discord desconectado.');
                }
            } catch (_) { }

            try {
                const gs = getGmailService();
                if (gs) gs.pararGmailMonitor();
            } catch (_) { }

            try {
                if (state.telegram) {
                    await state.telegram.disconnect();
                    state.statusConexoes.telegram = false;
                }
            } catch (_) { }

            if (state.io) {
                state.io.emit('status', state.statusConexoes);
                state.io.emit('bot-status', { rodando: false });
            }

            res.json({ ok: true, mensagem: 'Bot parado com sucesso.' });
        } catch (err) {
            log('', `Erro ao parar bot: ${err.message}`);
            res.status(500).json({ ok: false, mensagem: 'Erro ao parar o bot.' });
        }
    });

    app.post('/api/bot/ligar', async (req, res) => {
        if (state.botRodando) {
            return res.json({ ok: true, mensagem: 'Bot já está rodando.' });
        }

        try {
            state.botRodando = true;
            log('🟢', '[DASHBOARD] Bot LIGADO pelo painel de controle.');

            try {
                if (client) {
                    await client.login(config.discord.token);
                    state.statusConexoes.discord = true;
                    state.discordClient = client;
                    log('🟢', '[DASHBOARD] Discord reconectado.');
                }
            } catch (loginErr) {
                log('', `Erro ao reconectar Discord: ${loginErr.message}`);
            }

            try {
                const gs = getGmailService();
                if (gs) gs.iniciarGmailMonitor();
            } catch (_) { }

            try {
                if (client && !state.statusConexoes.telegram) {
                    const tgMod = getTelegramModule();
                    if (tgMod) {
                        state.heartbeat.tentativaReconexaoTelegram = 0;
                        tgMod.ligarTelegram(client);
                        log('️', '[DASHBOARD] Telegram reconectando...');
                    }
                }
            } catch (_) { }

            if (state.io) {
                state.io.emit('status', state.statusConexoes);
                state.io.emit('bot-status', { rodando: true });
            }

            res.json({ ok: true, mensagem: 'Bot ligado com sucesso.' });
        } catch (err) {
            log('', `Erro ao ligar bot: ${err.message}`);
            res.status(500).json({ ok: false, mensagem: 'Erro ao ligar o bot.' });
        }
    });

    app.post('/api/discord/desligar', async (req, res) => {
        if (!state.statusConexoes.discord) {
            return res.json({ ok: true, mensagem: 'Discord já está desligado.' });
        }
        try {
            client.destroy();
            state.statusConexoes.discord = false;
            log('', '[DASHBOARD] Discord DESLIGADO (isolado).');
            if (state.io) state.io.emit('status', state.statusConexoes);
            res.json({ ok: true, mensagem: 'Discord desligado.' });
        } catch (err) {
            log('', `Erro ao desligar Discord: ${err.message}`);
            res.status(500).json({ ok: false, mensagem: 'Erro ao desligar Discord.' });
        }
    });

    app.post('/api/discord/ligar', async (req, res) => {
        if (state.statusConexoes.discord) {
            return res.json({ ok: true, mensagem: 'Discord já está conectado.' });
        }
        try {
            await client.login(config.discord.token);
            state.statusConexoes.discord = true;
            state.discordClient = client;
            log('🟢', '[DASHBOARD] Discord LIGADO (isolado).');
            if (state.io) state.io.emit('status', state.statusConexoes);
            res.json({ ok: true, mensagem: 'Discord reconectado.' });
        } catch (err) {
            log('', `Erro ao ligar Discord: ${err.message}`);
            res.status(500).json({ ok: false, mensagem: 'Erro ao ligar Discord.' });
        }
    });

    app.get('/api/stats', async (req, res) => {
        try {
            const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0);
            const ts = inicioHoje.getTime();

            const result = await db.getStats(ts, 0.50);

            res.json({
                hoje: {
                    receita: result.totalHoje || 0,
                    lucro: result.lucroHoje || 0,
                    vendas: result.qtdHoje || 0,
                },
                geral: {
                    receita: result.totalGeral || 0,
                    lucro: result.lucroGeral || 0,
                    vendas: result.qtdGeral || 0,
                },
                conexoes: state.statusConexoes,
                filasAtivas: state.filasPagamento.size,
                pagamentosPendentes: state.pagamentosRecentes.length,
                licenca: state.licencaInfo,
                botRodando: state.botRodando,
            });
        } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
    });

    app.get('/api/historico', async (req, res) => {
        try {
            const rows = await db.getHistorico(100);
            res.json(rows);
        } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
    });

    app.get('/api/vendas-hora', async (req, res) => {
        try {
            const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0);
            const rows = await db.getVendasPorHora(inicioHoje.getTime());
            res.json(rows);
        } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
    });

    app.get('/api/guilds', (req, res) => {
        try {
            if (!client || !client.guilds || !client.guilds.cache) {
                return res.json([]);
            }
            const guilds = client.guilds.cache.map(g => ({
                id: g.id,
                name: g.name,
                icon: g.iconURL({ size: 64 }) || null,
                memberCount: g.memberCount || 0,
            }));
            res.json(guilds);
        } catch (err) {
            log('', `[API] Erro ao listar guilds: ${err.message}`);
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    app.get('/api/guilds/:guildId/channels', (req, res) => {
        try {
            const guild = client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json({ error: 'Guild não encontrado' });

            const categorias = guild.channels.cache
                .filter(c => c.type === 4)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));

            res.json(categorias);
        } catch (err) {
            log('', `[API] Erro ao listar canais: ${err.message}`);
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    const autoResponder = require('../services/autoResponder');

    app.get('/api/autoresponder/:guildId', (req, res) => {
        try {
            const orgRegras = autoResponder.getRegrasOrg(req.params.guildId);
            if (!orgRegras) {
                return res.json(autoResponder.getRegrasPadrao());
            }
            res.json(orgRegras);
        } catch (err) {
            log('', `[API] Erro ao buscar regras: ${err.message}`);
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    app.post('/api/autoresponder/:guildId', (req, res) => {
        try {
            const guildId = req.params.guildId;
            const body = req.body;

            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: 'Body inválido' });
            }

            const novasRegras = {
                categoriaId: String(body.categoriaId || '').trim(),
                admOn: {
                    ativo: Boolean(body.admOn?.ativo),
                    palavrasChave: Array.isArray(body.admOn?.palavrasChave)
                        ? body.admOn.palavrasChave.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
                        : [],
                    resposta: String(body.admOn?.resposta || ' Adm SEMPRE ON.').substring(0, 2000),
                    cooldownMs: Math.max(5000, Math.min(300000, Number(body.admOn?.cooldownMs) || 60000)),
                },
            };

            autoResponder.setRegrasOrg(guildId, novasRegras);
            log('', `[AUTO-RESPONDER] Regras salvas para guild ${guildId}`);
            res.json({ ok: true, mensagem: 'Regras salvas com sucesso!' });
        } catch (err) {
            log('', `[API] Erro ao salvar regras: ${err.message}`);
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    const serverRules = require('../services/serverRules');

    app.get('/api/serverrules/:guildId', (req, res) => {
        try {
            const orgConfig = serverRules.getRegrasOrg(req.params.guildId);
            if (!orgConfig) {
                return res.json({
                    regrasTexto: '',
                    ativo: false,
                    cooldownMs: 30000,
                    categoriaId: '',
                    escopo: 'filas',
                });
            }
            res.json(orgConfig);
        } catch (err) {
            log('', `[API] Erro ao buscar server rules: ${err.message}`);
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    app.post('/api/serverrules/:guildId', (req, res) => {
        try {
            const guildId = req.params.guildId;
            const body = req.body;

            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: 'Body inválido' });
            }

            const novaConfig = {
                regrasTexto: String(body.regrasTexto || '').substring(0, 15000),
                ativo: Boolean(body.ativo),
                cooldownMs: Math.max(5000, Math.min(300000, Number(body.cooldownMs) || 30000)),
                categoriaId: String(body.categoriaId || '').trim(),
                escopo: ['filas', 'todos', 'categoria'].includes(body.escopo) ? body.escopo : 'filas',
            };

            serverRules.setRegrasOrg(guildId, novaConfig);
            log('', `[SERVER-RULES] Regras salvas para guild ${guildId}`);
            res.json({ ok: true, mensagem: 'Regras do servidor salvas com sucesso!' });
        } catch (err) {
            log('', `[API] Erro ao salvar server rules: ${err.message}`);
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    const threadMsgConfig = require('../services/threadMessageConfig');

    app.get('/api/thread-message', (req, res) => {
        try {
            const cfg = threadMsgConfig.getConfig();
            res.json(cfg);
        } catch (err) {
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    app.post('/api/thread-message', (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: 'Body inválido' });
            }
            threadMsgConfig.setConfig({
                mensagem: body.mensagem || '',
                incluirPix: Boolean(body.incluirPix),
                pixChave: body.pixChave || ''
            });
            log('', `[THREAD-MSG] Config atualizada via dashboard.`);
            res.json({ ok: true, mensagem: 'Mensagem da thread salva com sucesso!' });
        } catch (err) {
            log('', `[API] Erro ao salvar thread message: ${err.message}`);
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    const PORT = config.dashboardPort;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n Painel Web rodando na porta ${PORT} (0.0.0.0)!\n`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`️ Porta ${PORT} em uso. Tentando ${PORT + 1}...`);
            server.listen(PORT + 1, '0.0.0.0', () => {
                console.log(`\n Painel Web rodando na porta ${PORT + 1} (0.0.0.0)!\n`);
            });
        } else {
            console.log('️ Erro no servidor web:', err.message);
        }
    });

    return { app, server, io };
}

module.exports = { iniciarDashboard };
