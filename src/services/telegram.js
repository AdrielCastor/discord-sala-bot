const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { EditedMessage } = require('telegram/events/EditedMessage');
const config = require('../config');
const { log } = require('../logger');
const state = require('../state');
const goService = require('./goCommandService');
const roomPanelService = require('./roomPanelService');

const RECONEXAO_DELAYS = [10000, 20000, 40000, 60000, 120000, 300000];

const _goMsgEnviadas = new state.BoundedSet(30);
const _equipesEnviadas = new state.BoundedSet(30);
let _processandoSalaCriada = false;

function parseEquipesTelegram(textoOriginal) {
    const jogadores = { equipe1: [], equipe2: [] };
    const linhas = textoOriginal.split('\n');
    let equipeAtual = null;

    for (const linha of linhas) {
        const linhaLower = linha.toLowerCase().trim();

        if (linhaLower.includes('time 1') || linhaLower.includes('equipe 1')) {
            equipeAtual = 'equipe1';
            continue;
        }
        if (linhaLower.includes('time 2') || linhaLower.includes('equipe 2')) {
            equipeAtual = 'equipe2';
            continue;
        }

        if (!equipeAtual) continue;

        const matchUniversal = linha.match(/(.+?)\s*(?:—|–|-|\|)\s*(\d{5,})/i);

        if (matchUniversal) {
            let nomeRaw = matchUniversal[1].trim();
            let id = matchUniversal[2];
            let tipo = '';

            nomeRaw = nomeRaw.replace(/^[\u2705\u2611\u2713]\s*/, '');

            jogadores[equipeAtual].push({ nome: nomeRaw, id, tipo });
        }
    }

    return jogadores;
}

function formatarEquipesDiscord(salaID, jogadores, criadaEm) {
    const agora = Date.now();
    const elapsed = Math.floor((agora - (criadaEm || agora)) / 1000);
    const remaining = Math.max(0, 180 - elapsed);
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;

    let texto = `## \uD83C\uDFDF\uFE0F SALA CRIADA!\n\n`;
    texto += `\u23F3 GO em ${min}min ${sec.toString().padStart(2, '0')}s\n\n`;

    texto += `**Equipe 1:**\n`;
    if (jogadores.equipe1.length > 0) {
        for (const j of jogadores.equipe1) {
            texto += `\u2502 ${j.tipo} ${j.nome} (${j.id})\n`;
        }
    } else {
        texto += `\u2502 _Ningu\u00e9m_\n`;
    }

    texto += `\n**Equipe 2:**\n`;
    if (jogadores.equipe2.length > 0) {
        for (const j of jogadores.equipe2) {
            texto += `\u2502 ${j.tipo} ${j.nome} (${j.id})\n`;
        }
    } else {
        texto += `\u2502 _Ningu\u00e9m_\n`;
    }

    const total = jogadores.equipe1.length + jogadores.equipe2.length;
    texto += `\n\uD83D\uDC51 **${total}** jogadores`;

    return texto;
}

function enviarMensagemGo(channel, salaID) {
    if (_goMsgEnviadas.has(salaID)) return;
    _goMsgEnviadas.add(salaID);

    setTimeout(async () => {
        try {
            const sala = goService.getSala(salaID);
            const jogadores = sala?.jogadores || null;
            let texto;

            if (jogadores && (jogadores.equipe1.length > 0 || jogadores.equipe2.length > 0)) {
                texto = formatarEquipesDiscord(salaID, jogadores, sala?.criadaEm);
                texto += `\n\n Pra iniciar, os dois devem enviar: \`.go ${salaID}\``;
            } else {
                texto =
                    ` **Quer iniciar instantaneamente?**\n` +
                    `Os dois jogadores devem enviar: \`.go ${salaID}\`\n\n` +
                    ` Sala: **${salaID}**\n` +
                    ` Aguardando dados das equipes...`;
            }
            await channel.send(texto);
            log('', `[GO-MSG] Painel + .go enviado para sala ${salaID}`);
        } catch (err) {
            log('️', `[GO-MSG] Erro ao enviar: ${err.message}`);
        }

        state.startTrackedTimeout(() => _goMsgEnviadas.delete(salaID), 10 * 60 * 1000);
    }, 3000);
}

const tgFluxo = {
    etapa: 'idle',
    ultimoMsgId: null,
    ultimoTexto: '',
    ultimaSalaID: null,
    ultimoComando: null,
    timestamp: 0,
    falhasConsecutivas: 0,

    avancar(novaEtapa) {
        log('', `Fluxo Telegram: ${this.etapa} → ${novaEtapa}`);
        this.etapa = novaEtapa;
        this.timestamp = Date.now();
    },

    reset() {
        this.etapa = 'idle';
        this.ultimoMsgId = null;
        this.ultimoTexto = '';
        this.timestamp = Date.now();
    },

    sucesso() {
        this.falhasConsecutivas = 0;
    },

    verificarTimeout() {
        if (this.etapa !== 'idle' && (Date.now() - this.timestamp) > 60000) {
            this.falhasConsecutivas++;
            log('️', `Fluxo travou na etapa "${this.etapa}". Resetando... (falhas consecutivas: ${this.falhasConsecutivas})`);
            this.reset();
            return true;
        }
        return false;
    }
};

async function ligarTelegram(discordClient) {
    if (!config.telegram.apiId) return;

    if (state._tgWatchdogId) {
        clearInterval(state._tgWatchdogId);
        state._tgWatchdogId = null;
    }

    try {
        const tg = new TelegramClient(
            new StringSession(config.telegram.chaveMestra),
            config.telegram.apiId,
            config.telegram.apiHash,
            {
                connectionRetries: 10,
                requestRetries: 5,
                timeout: 120000,
                retryDelay: 2000,
                autoReconnect: true
            }
        );
        await tg.connect();
        state.telegram = tg;
        log('️', 'Ponte Telegram conectada!');
        state.statusConexoes.telegram = true;
        state.heartbeat.tentativaReconexaoTelegram = 0;
        if (state.io) state.io.emit('status', state.statusConexoes);

        async function clicarBotao(textoProcurado, delayMs = 2000) {
            try {
                await new Promise(r => setTimeout(r, delayMs));
                const historico = await tg.getMessages(config.telegram.alvo, { limit: 3 });

                if (!historico || historico.length === 0) return false;

                const textos = Array.isArray(textoProcurado) ? textoProcurado : [textoProcurado];

                for (const msgReal of historico) {
                    const botoes = await msgReal.getButtons();
                    if (!botoes || botoes.length === 0) continue;

                    const todosBotoes = [];
                    for (const row of botoes) {
                        for (const b of row) {
                            if (b.text) todosBotoes.push(b.text);
                        }
                    }
                    log('', `[BOTÕES] Encontrados: [${todosBotoes.join(' | ')}] | Procurando: [${textos.join(' / ')}]`);

                    for (let i = 0; i < botoes.length; i++) {
                        for (let j = 0; j < botoes[i].length; j++) {
                            const botao = botoes[i][j];
                            const botaoLower = (botao.text || '').toLowerCase();
                            const match = textos.some(t => botaoLower.includes(t.toLowerCase()));
                            if (match) {
                                log('', `Telegram Clicou: [${botao.text}]`);
                                await msgReal.click(i, j);
                                return true;
                            }
                        }
                    }
                }
                log('️', `Botão "${textos.join(' / ')}" não encontrado.`);
            } catch (err) { log('', `Erro ao clicar: ${err.message}`); }
            return false;
        }

        function determinarModo() {
            const salaAtual = state.threadsAguardandoSala.first ? state.threadsAguardandoSala.first() : state.threadsAguardandoSala.get(0);
            const cmd = tgFluxo.ultimoComando;

            if (cmd === '+cs 2') return 'gel_infinito';
            if (cmd === '+cs 3') return 'capa';
            if (cmd === '+cs' || cmd === '+cscpx' || cmd === '.cs') return salaAtual?.modo || '4x4_apostado';

            if (salaAtual?.modo) return salaAtual.modo;
            if (salaAtual?.infinito) return 'gel_infinito';

            return '4x4_apostado';
        }

        async function processarMensagemTelegram(text, msgId, originalText) {
            if (originalText && (text.includes('equipes da sala') || text.includes('jogadores na sala') || text.includes('total jogadores') || (text.includes('time 1') && (text.includes('emulador') || text.includes('mobile') || text.includes('') || text.includes('') || text.includes('') || text.includes('time 2'))))) {
                const jogadores = parseEquipesTelegram(originalText);
                const total = jogadores.equipe1.length + jogadores.equipe2.length;
                if (total > 0) {
                    let sala = goService.getSalaByTgMsgId(msgId);
                    let salaID = sala ? sala.salaID : tgFluxo.ultimaSalaID;

                    if (!sala && salaID) {
                        sala = goService.getSala(salaID);
                    }

                    if (!sala) {
                        for (const [id, s] of goService.salasAtivas) {
                            if (!s.iniciada && (Date.now() - s.criadaEm) < 10 * 60 * 1000) {
                                sala = s;
                                salaID = id;
                            }
                        }
                        if (sala) {
                            log('', `[EQUIPES] Fallback: associando jogadores à sala mais recente ${salaID}`);
                        }
                    }

                    if (sala) {
                        salaID = sala.salaID;
                        sala.jogadores = jogadores;
                        log('', `[EQUIPES] ${total} jogadores detectados para sala ${salaID}`);

                        if (sala.threadId && sala.threadId !== 'telegram_direct') {
                            const painelAtualizado = await roomPanelService.atualizarPainelDeSala(salaID, discordClient);

                            if (!painelAtualizado && !_equipesEnviadas.has(salaID)) {
                                _equipesEnviadas.add(salaID);
                                try {
                                    const thread = await discordClient.channels.fetch(sala.threadId);
                                    const textoEquipes = formatarEquipesDiscord(salaID, jogadores, sala.criadaEm);
                                    await thread.send(textoEquipes);
                                    log('', `[EQUIPES] Painel enviado (fallback) para sala ${salaID}`);
                                } catch (err) {
                                    log('️', `[EQUIPES] Erro ao enviar: ${err.message}`);
                                }
                            } else if (painelAtualizado) {
                                log('', `[EQUIPES] Painel atualizado para sala ${salaID}`);
                            }
                        }
                    } else {
                        log('️', `[EQUIPES] ${total} jogadores detectados mas nenhuma sala ativa encontrada (msgId: ${msgId}, ultimaSalaID: ${tgFluxo.ultimaSalaID})`);
                    }
                }
            }

            if (text.includes('saldo') && !text.includes('sala criada')) {
                const saldoDetectado = roomPanelService.parseSaldoTelegram(originalText || text);
                if (saldoDetectado !== null) {
                    let salaSaldo = goService.getSalaByTgMsgId(msgId);
                    let salaIDSaldo = salaSaldo ? salaSaldo.salaID : tgFluxo.ultimaSalaID;

                    if (!salaSaldo && salaIDSaldo) {
                        salaSaldo = goService.getSala(salaIDSaldo);
                    }

                    if (salaSaldo && salaSaldo.saldo !== saldoDetectado) {
                        salaSaldo.saldo = saldoDetectado;
                        log('', `[SALDO] Atualizado: ${saldoDetectado} salas para sala ${salaIDSaldo}`);
                        if (salaSaldo.threadId && salaSaldo.threadId !== 'telegram_direct') {
                            await roomPanelService.atualizarPainelDeSala(salaIDSaldo, discordClient);
                        }
                    }
                }
            }

            if (state.threadsAguardandoSala.length === 0) return;

            if (msgId && msgId === tgFluxo.ultimoMsgId && text === tgFluxo.ultimoTexto) return;
            tgFluxo.ultimoMsgId = msgId;
            tgFluxo.ultimoTexto = text;

            tgFluxo.verificarTimeout();

            const textPreview = text.substring(0, 150).replace(/\n/g, ' ');
            log('', `[${tgFluxo.etapa}] Telegram: "${textPreview}"`);

            try {
                tgFluxo.sucesso();

                if (text.includes('sala criada') && text.includes('id:') && text.includes('senha:')) {
                    const idMatch = text.match(/id:\s*(\d+)/i);
                    const senhaMatch = text.match(/senha:\s*([\w\d]+)/i);

                    if (idMatch && senhaMatch) {
                        const salaID = idMatch[1];
                        const salaSenha = senhaMatch[1];

                        if (_processandoSalaCriada) {
                            log('', `[MUTEX] Outro handler já está processando sala criada. Ignorando.`);
                            return;
                        }
                        _processandoSalaCriada = true;

                        const salaIDLimpo = salaID.replace(/^edit_/, '');
                        if (state.salasIDsProcessados.has(salaIDLimpo)) {
                            log('', `[BLOQUEADO] Sala ID: ${salaIDLimpo} já processada anteriormente. Ignorando duplicata/edição.`);
                            _processandoSalaCriada = false;
                            return;
                        }
                        state.salasIDsProcessados.add(salaIDLimpo);

                        tgFluxo.ultimaSalaID = salaID;

                        log('', 'SALA CRIADA detectada!');
                        log('', `Sala Capturada! ID: ${salaID} | Senha: ${salaSenha}`);

                        const salaAtual = state.threadsAguardandoSala.shift();
                        tgFluxo.reset();

                        if (!salaAtual) {
                            log('️', `[TELEGRAM] Sala ${salaID} criada mas fila vazia (nenhum canal aguardando).`);
                            _processandoSalaCriada = false;
                            return;
                        }

                        if (salaAtual.id !== 'telegram_direct') {
                            const salaExistenteNoCanal = state.salasAtivasPorCanal.get(salaAtual.id);
                            if (salaExistenteNoCanal) {
                                log('', `[BLOQUEADO] Canal ${salaAtual.id} já tem sala ativa: ${salaExistenteNoCanal}. Não enviando sala ${salaID}.`);
                                state._criacaoSalaLocks.delete(salaAtual.id);
                                _processandoSalaCriada = false;
                                return;
                            }
                        }

                        const goService = require('./goCommandService');
                        goService.registrarSala(salaID, salaSenha, salaAtual.id, msgId ? parseInt(msgId) : null);

                        if (salaAtual.id === 'telegram_direct') {
                            try {
                                await tg.sendMessage(config.telegram.alvo, {
                                    message: ` Sala criada!\n ID: ${salaID}\n Senha: ${salaSenha}`
                                });
                                log('', 'Sala criada via +cs — resultado enviado no Telegram!');
                            } catch (err) { log('', `Erro ao enviar resultado no Telegram: ${err.message}`); }
                        } else {
                            try {
                                const thread = await discordClient.channels.fetch(salaAtual.id);
                                await thread.send(`${salaID}`);
                                await thread.send(`${salaSenha}`);
                                await thread.send(`!sala ${salaID} ${salaSenha}`);
                                log('', 'Sala enviada no Discord!');

                                const dadosExtras = roomPanelService.parseDadosExtrasSala(originalText);
                                const salaRef = goService.getSala(salaID);
                                if (salaRef) {
                                    const modoMap = { '4x4_apostado': 'Padrão Apostado', 'gel_infinito': 'Gel Infinito', 'capa': 'Full Capa', 'gelo_martelo': 'Gelo/Martelo', '2x2': '2x2', '1x1': '1x1' };
                                    salaRef.modo = dadosExtras.modo || modoMap[salaAtual.modo] || 'Padrão Apostado';
                                    salaRef.horaInicio = dadosExtras.horaInicio || null;
                                    salaRef.saldo = dadosExtras.saldo || null;
                                }

                                state.startTrackedTimeout(() => {
                                    roomPanelService.criarPainel(salaAtual.id, salaID, discordClient).catch(err => {
                                        log('️', `[PAINEL] Erro ao criar: ${err.message}`);
                                    });
                                }, 1500);
                            } catch (err) { log('', `Erro ao enviar sala: ${err.message}`); }
                        }
                    }
                    _processandoSalaCriada = false;
                    return;
                }

                if (text.includes('use /start') || text.includes('acessar o menu principal')) {
                    log('', 'Bot pediu /start. Enviando comando automaticamente...');
                    await enviarStart();
                    return;
                }

                if (text.includes('criando sala') || text.includes('buscando sala')) {
                    tgFluxo.avancar('criando');
                    return;
                }

                if (
                    text.includes('escolha o modo desejado') &&
                    (tgFluxo.etapa === 'idle' || tgFluxo.etapa === 'menu' || tgFluxo.etapa === 'criando')
                ) {
                    tgFluxo.avancar('modo');
                    const modo = determinarModo();
                    log('️', `Decidindo modo: ultimoComando=${tgFluxo.ultimoComando} | modo detectado=${modo}`);

                    if (modo === 'gel_infinito') {
                        log('️', 'Modo: GEL INFINITO');
                        await clicarBotao(['gel infinito', 'gelo infinito', 'infinito']);
                    } else if (modo === 'gelo_martelo') {
                        log('️', 'Modo: GELO/MARTELO');
                        await clicarBotao(['gelo', 'martelo', '5 gelo']);
                    } else if (modo === '2x2') {
                        log('️', 'Modo: 2x2');
                        await clicarBotao(['2x2', '2v2']);
                    } else if (modo === '1x1') {
                        log('️', 'Modo: 1x1');
                        await clicarBotao(['1x1', '1v1']);
                    } else if (modo === 'capa') {
                        log('️', 'Modo: CAPA');
                        await clicarBotao(['full capa', 'capa']);
                    } else {
                        log('️', 'Modo: PADRÃO CPX');
                        await clicarBotao(['padrão cpx', 'padrao cpx', '4x4 padrão apostado', '4x4 apostado', 'padrão apostado', '4x4 padrao']);
                    }
                    tgFluxo.ultimoComando = null;
                    return;
                }

                if (
                    text.includes('selecione uma opção abaixo') &&
                    (tgFluxo.etapa === 'idle' || tgFluxo.etapa === 'criando') && !text.includes('escolha o modo desejado')
                ) {
                    tgFluxo.avancar('menu');
                    log('', 'Menu Principal → Clicando "Criar Sala"...');
                    const clicou = await clicarBotao('criar sala');
                    if (!clicou) tgFluxo.reset();
                    return;
                }

            } catch (err) { log('', `Erro no processamento: ${err.message}`); }
        }

        tg.addEventHandler(async (event) => {
            const msg = event.message;
            if (!msg) return;
            const originalText = msg.message || msg.text || '';
            const text = originalText.toLowerCase();
            const msgId = msg.id ? String(msg.id) : null;

            if (text) {
                const preview = text.substring(0, 120).replace(/\n/g, ' ');
                log('', `[TG-IN] De: ${msg.senderId || 'desconhecido'} | Etapa: ${tgFluxo.etapa} | Fila: ${state.threadsAguardandoSala.length} | "${preview}"`);
                await processarMensagemTelegram(text, msgId, originalText);
            }
        }, new NewMessage({ incoming: true }));

        tg.addEventHandler(async (event) => {
            const msg = event.message;
            if (!msg) return;
            const text = (msg.message || msg.text || '').trim().toLowerCase();
            if (!text) return;

            const csMatch = text.match(/^\+(?:cs|cscpx)(?:\s+(.+))?$/);
            if (!csMatch) return;

            const argRaw = (csMatch[1] || '').trim();
            let modo = '4x4_apostado';
            let modoNome = 'Padrão Apostado';
            let comandoTelegram = '+cs';

            if (argRaw.startsWith('2')) {
                modo = 'gel_infinito';
                modoNome = 'Gel Infinito';
                comandoTelegram = '+cs 2';
            } else if (argRaw.startsWith('3')) {
                modo = 'capa';
                modoNome = 'Capa';
                comandoTelegram = '+cs 3';
            }

            log('', `[TELEGRAM SHORTCUT] Detectado → modo: ${modoNome} | Comando: "${comandoTelegram}"`);

            if (state.threadsAguardandoSala.length > 0) {
                log('️', `[TELEGRAM SHORTCUT] Já tem ${state.threadsAguardandoSala.length} sala(s) na fila. Ignorando...`);
                return;
            }

            const agora = Date.now();
            const ultimoCsTg = state.cooldownBotaoSala.get('telegram_direct');
            if (ultimoCsTg && (agora - ultimoCsTg) < 30000) {
                log('', `[TELEGRAM SHORTCUT] Cooldown ativo. Ignorando.`);
                return;
            }
            state.cooldownBotaoSala.set('telegram_direct', agora);

            state.threadsAguardandoSala.push({
                id: 'telegram_direct',
                infinito: modo === 'gel_infinito',
                modo: modo,
                comandoTelegram: comandoTelegram,
                criadoEm: Date.now(),
            });

            tgFluxo.ultimoComando = comandoTelegram;
            await enviarComandoSala(comandoTelegram);
        }, new NewMessage({ outgoing: true }));

        tg.addEventHandler(async (event) => {
            const msg = event.message;
            if (!msg) return;
            const originalText = msg.message || msg.text || '';
            const text = originalText.toLowerCase();
            const msgId = msg.id ? `edit_${msg.id}` : null;

            if (!text) return;

            const preview = text.substring(0, 120).replace(/\n/g, ' ');
            log('', `[TG-EDIT] MsgId: ${msg.id} | "${preview}"`);

            await processarMensagemTelegram(text, msgId, originalText);
        }, new EditedMessage({}));

        const _watchdogId = setInterval(async () => {
            if (tgFluxo.etapa !== 'idle' && (Date.now() - tgFluxo.timestamp) > 60000) {
                tgFluxo.falhasConsecutivas++;
                log('️', `Watchdog: Fluxo Telegram travou na etapa "${tgFluxo.etapa}". Resetando para tentar de novo... (falhas: ${tgFluxo.falhasConsecutivas})`);
                tgFluxo.reset();
            }

            if (tgFluxo.etapa === 'idle' && state.threadsAguardandoSala.length > 0) {
                const proxSala = state.threadsAguardandoSala[0] || state.threadsAguardandoSala.first?.();

                if (tgFluxo.falhasConsecutivas >= 2) {
                    log('', `Watchdog: ${tgFluxo.falhasConsecutivas} falhas consecutivas com +cs. Escalando para /start pra resetar o bot...`);
                    tgFluxo.falhasConsecutivas = 0;
                    await enviarStart();
                } else {
                    const cmd = proxSala?.comandoTelegram || tgFluxo.ultimoComando || '/start';
                    log('', `Watchdog: A fila tem ${state.threadsAguardandoSala.length} requisição(ões). Enviando "${cmd}"...`);
                    if (cmd === '/start') {
                        await enviarStart();
                    } else {
                        await enviarComandoSala(cmd);
                    }
                }
            }
        }, 15000);

        state._tgWatchdogId = _watchdogId;

    } catch (err) {
        state.statusConexoes.telegram = false;
        if (state.io) state.io.emit('status', state.statusConexoes);

        const hb = state.heartbeat;
        const delay = RECONEXAO_DELAYS[Math.min(hb.tentativaReconexaoTelegram, RECONEXAO_DELAYS.length - 1)];
        hb.tentativaReconexaoTelegram++;

        log('', `Telegram falhou: ${err.message}. Reconectando em ${delay / 1000}s...`);
        state.startTrackedTimeout(() => ligarTelegram(discordClient), delay);
    }
}

async function enviarStart() {
    if (!state.telegram) return false;
    try {
        log('', `Enviando /start para [${config.telegram.alvo}]...`);
        tgFluxo.reset();
        await state.telegram.sendMessage(config.telegram.alvo, { message: '/start' });
        return true;
    } catch (err) {
        log('️', `Aguardando conexão com Telegram para enviar /start...`);
        return false;
    }
}

async function enviarComandoSala(comando) {
    if (!state.telegram) return false;
    try {
        log('', `Enviando comando "${comando}" para [${config.telegram.alvo}]...`);
        tgFluxo.avancar('criando');
        await state.telegram.sendMessage(config.telegram.alvo, { message: comando });
        return true;
    } catch (err) {
        log('️', `Erro ao enviar comando "${comando}": ${err.message}`);
        return false;
    }
}

module.exports = { ligarTelegram, enviarStart, enviarComandoSala, tgFluxo };