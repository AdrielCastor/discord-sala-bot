const { MessageAttachment } = require('discord.js-selfbot-v13');
const config = require('../../config');
const { log } = require('../../logger');
const state = require('../../state');
const db = require('../../database');
const { normalizarNome, nomeConfere, gerarPayloadPix, gerarQRCodeBuffer } = require('../../utils');
const { humanReply, randomDelay } = require('../helpers');
const paymentLogic = require('./payment');

const { ligarTelegram } = require('../../services/telegram');

let goService = null;
let telegramForceStart = null;
try { goService = require('../../services/goCommandService'); } catch (_) { }
try { telegramForceStart = require('../../services/telegramForceStart'); } catch (_) { }

const _cmdCooldowns = new state.BoundedMap(50);
const CMD_COOLDOWN_MS = 4000;

function checkCmdCooldown(userId, cmd) {
    const key = `${userId}:${cmd}`;
    const agora = Date.now();
    const ultimo = _cmdCooldowns.get(key);
    if (ultimo && (agora - ultimo) < CMD_COOLDOWN_MS) return true;
    _cmdCooldowns.set(key, agora);
    return false;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const MSGS = {
    infoinfo: [
        ` **COMO FUNCIONA O BOT DE SALAS?**\n\n **PASSO A PASSO:**\n**1.** Faça o Pix no valor exato da sua cota.\n**2.** Digite aqui: \`Pg SeuNome SeuSobrenome\`.\n**3.** **Não mande comprovante!** A gente lê o Pix direto no banco.\n**4.** Após 2 confirmações, a sala é criada automaticamente!`,
        ` **COMO USAR O BOT?**\n\n**1.** Paga o Pix com o valor certinho da sua cota\n**2.** Depois manda: \`Pg Nome Sobrenome\`\n**3.** Sem comprovante! O bot confirma automático pelo banco\n**4.** Com 2 pagamentos confirmados a sala já sai!`,
        ` **BOT DE SALAS AUTOMÁTICO**\n\n Como funciona:\n**1.** Faz o Pix no valor da cota\n**2.** Manda aqui: \`Pg Nome Sobrenome\`\n**3.** Não precisa de comprovante, a confirmação é automática\n**4.** A sala é criada assim que 2 jogadores confirmarem!`,
    ],
    goConfirmado: [
        (id, atual, total) => ` Confirmado pra sala **${id}**! Falta o outro jogador... (${atual}/${total})`,
        (id, atual, total) => ` Registrado na sala **${id}**. Aguardando confirmação... (${atual}/${total})`,
        (id, atual, total) => ` Show, confirmação da sala **${id}** recebida! (${atual}/${total})`,
    ],
    goAmbos: [
        (id) => ` **Ambos confirmaram a sala ${id}!** Iniciando a partida...`,
        (id) => ` **Sala ${id} confirmada por ambos!** Partida começando...`,
        (id) => ` **Todo mundo pronto na sala ${id}!** Forçando início...`,
    ],
    goSemId: [
        ' Manda o ID da sala. Ex: `.go 12345`',
        ' Faltou o ID! Usa: `.go 12345`',
        ' Preciso do ID da sala, manda tipo `.go 12345`',
    ],
    goNaoEncontrada: [
        (id) => ` Sala **${id}** não encontrada.`,
        (id) => ` Não achei a sala **${id}**.`,
        (id) => ` Nenhuma sala com ID **${id}** ativa.`,
    ],
    goJaConfirmou: [
        '️ Você já confirmou. Só esperar o outro jogador.',
        '️ Já registrei sua confirmação, aguarda aí.',
        '️ Já tá confirmado, falta só o outro.',
    ],
    goExpirada: [
        '️ Essa sala já expirou.',
        '️ Tempo de confirmação passou.',
        '️ Sala expirada, não dá mais pra confirmar.',
    ],
    goJaIniciada: [
        '️ Essa partida já começou.',
        '️ A sala já foi iniciada.',
        '️ Partida em andamento.',
    ],
    goCooldown: [
        ' Calma, espera uns segundos pra mandar de novo.',
        ' Aguarda um pouco antes de usar o .go de novo.',
        ' Devagar aí, tenta de novo em alguns segundos.',
    ],
};

async function handleInfo(m, _txtRaw, client) {
    if (m.author.id !== client.user.id) return;
    if (checkCmdCooldown(m.author.id, 'infoinfo')) return;
    await humanReply(m, pick(MSGS.infoinfo));
}

async function handleRevanche(m, txtRaw, client) {
    const args = txtRaw.replace('.rv', '').trim();
    let modo = '4x4_apostado';

    if (args === 'inf') {
        modo = 'gel_infinito';
    } else if (args === 'capa') {
        modo = 'full_capa';
    }

    const channelId = m.channel.id;

    const salaExistente = state.salasAtivasPorCanal.get(channelId);
    if (salaExistente) {
        state.salasAtivasPorCanal.delete(channelId);
        if (goService) {
            const salaAnterior = goService.getSala(salaExistente);
            if (salaAnterior && salaAnterior.confirmados) salaAnterior.confirmados.clear();
            goService.salasAtivas.delete(salaExistente);
        }
    }

    if (state._criacaoSalaLocks.has(channelId)) {
        await humanReply(m, '️ Já tem uma sala sendo criada nesse canal. Aguarde.');
        return;
    }

    const agora = Date.now();
    const ultimaCriacao = state.cooldownBotaoSala.get(channelId);
    if (ultimaCriacao && (agora - ultimaCriacao) < 30000) {
        const restante = Math.ceil((30000 - (agora - ultimaCriacao)) / 1000);
        await humanReply(m, ` Aguarde **${restante}s** antes de solicitar outra sala.`);
        return;
    }

    const jaEnfileirado = state.threadsAguardandoSala.some(t => t.id === channelId);
    if (jaEnfileirado) {
        await humanReply(m, '️ Já tem uma solicitação de sala pendente nesse canal.');
        return;
    }

    state._criacaoSalaLocks.add(channelId);
    state.cooldownBotaoSala.set(channelId, agora);

    const isInfinito = modo === 'gel_infinito';
    const modoDisplay = modo.replace('_', ' ');
    const rvMsgs = [
        `️ **REVANCHE!** Criando sala no modo: **${modoDisplay}**...`,
        `️ Bora de revanche! Modo: **${modoDisplay}**. Já tô criando...`,
        `️ Revanche solicitada! Preparando sala **${modoDisplay}**...`,
    ];
    await humanReply(m, pick(rvMsgs));

    const comandoMap = { '4x4_apostado': '+cs', 'gel_infinito': '+cs 2', 'full_capa': '+cs 3' };
    state.threadsAguardandoSala.push({ id: channelId, infinito: isInfinito, modo: modo, comandoTelegram: comandoMap[modo] || '+cs', criadoEm: Date.now() });

    state.startTrackedTimeout(() => {
        if (state._criacaoSalaLocks.has(channelId)) {
            state._criacaoSalaLocks.delete(channelId);
        }
    }, 120000);
}

async function handleStatus(m) {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    await humanReply(m,
        ` **STATUS DO BOT** \n\n` +
        `🟢 **Discord:** ${state.statusConexoes.discord ? ' Online' : ' Offline'}\n` +
        ` **Webhook PIX:** ${config.discord.canalWebhookId ? ' Ativo' : ' Não configurado'}\n` +
        `️ **Telegram:** ${state.statusConexoes.telegram ? ' Online' : ' Offline'}\n\n` +
        ` **Pagamentos pendentes:** ${state.pagamentosRecentes.filter(p => !p.filaUsada).length}\n` +
        ` **Filas ativas:** ${state.filasPagamento.size}\n` +
        ` **Salas aguardando:** ${state.threadsAguardandoSala.length}\n` +
        `⏱️ **Timers ativos:** ${state.getActiveTimerCount()}\n` +
        ` **Heap:** ${heapMB}MB | **RSS:** ${rssMB}MB\n` +
        `⏰ **Uptime:** ${Math.floor(process.uptime() / 60)} min`
    );
}

async function handleVerificar(m, txtRaw) {
    const nomeBusca = txtRaw.replace('.verificar', '').trim();
    if (!nomeBusca) {
        const vmsg = [' Manda o nome. Ex: `.verificar Nome Sobrenome`', ' Faltou o nome! Usa: `.verificar Nome Sobrenome`', ' Preciso do nome pra buscar.'];
        await humanReply(m, pick(vmsg));
        return;
    }
    const encontrados = state.pagamentosRecentes.filter(p => nomeConfere(nomeBusca, p.nomeCompleto));
    if (encontrados.length === 0) {
        const nfMsgs = [
            ` Não achei pagamento pra **"${nomeBusca}"**.\n Pagamentos expiram em 12 min.`,
            ` Nada encontrado com o nome **"${nomeBusca}"**.\n Os pagamentos ficam 12 min.`,
            ` Pagamento de **"${nomeBusca}"** não localizado.`,
        ];
        await humanReply(m, pick(nfMsgs));
    } else {
        const lista = encontrados.map((p, i) =>
            `**${i + 1}.** ${p.nomeCompleto} | R$${p.valor.toFixed(2)} | ${p.banco} | Usado: ${p.filaUsada ? 'Sim' : 'Não'} | ${p.proibido ? ' BARRADO' : ''}`
        ).join('\n');
        const hdrMsgs = [` **ENCONTREI ${encontrados.length} PAGAMENTO(S):**`, ` **${encontrados.length} resultado(s):**`, ` **Achei ${encontrados.length} pagamento(s):**`];
        await humanReply(m, `${pick(hdrMsgs)}\n\n${lista}`);
    }
}

async function handleReconectar(m, _txtRaw, client) {
    const rcMsgs = [' Reconectando, aguarda...', ' Forçando reconexão agora...', ' Reconectando o sistema, já volta.'];
    await humanReply(m, pick(rcMsgs));
    try {
        if (state.telegram && state.telegram.disconnect) await state.telegram.disconnect();
    } catch (_) { }
    state.statusConexoes.telegram = false;
    state.heartbeat.tentativaReconexaoTelegram = 0;
    state.startTrackedTimeout(() => ligarTelegram(client), 2000);
}

async function handleLucro(m) {
    try {
        const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0);
        const stats = await db.getStats(inicioHoje.getTime(), 0.50);
        await humanReply(m,
            ` **RELATÓRIO DE FATURAMENTO** \n\n` +
            `🟢 **HOJE:**\n` +
            ` Receita: R$ ${(stats.totalHoje || 0).toFixed(2)}\n` +
            ` Seu Lucro: R$ ${(stats.lucroHoje || 0).toFixed(2)}\n` +
            ` Salas/Vendas: ${stats.qtdHoje || 0}\n\n` +
            ` **TOTAL ACUMULADO:**\n` +
            ` Receita: R$ ${(stats.totalGeral || 0).toFixed(2)}\n` +
            ` Seu Lucro: R$ ${(stats.lucroGeral || 0).toFixed(2)}\n` +
            ` Salas/Vendas: ${stats.qtdGeral || 0}`
        );
    } catch (err) { }
}

async function handlePix(m, txtRaw) {
    const args = txtRaw.split(/\s+/);
    let chaveDestino = config.pix.chave;
    let nomeDestino = config.pix.nome;
    const filaAtual = state.filasPagamento.get(m.channel.id);
    let valorPix = filaAtual?.valor || 1.50;

    if (args.length > 1) {
        chaveDestino = args[1];
    }
    if (args.length > 2) {
        const parsed = parseFloat(args[2].replace(',', '.'));
        if (!isNaN(parsed) && parsed > 0) valorPix = parsed;
    }
    if (args.length > 3) {
        nomeDestino = args.slice(3).join(' ').toUpperCase();
    } else {
        const nomeCanal = (m.channel.name || '')
            .replace(/[^\p{L}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase();
        if (nomeCanal.length > 2) nomeDestino = nomeCanal;
    }

    const payload = gerarPayloadPix(chaveDestino, nomeDestino, 'SAO PAULO', valorPix, 'TX' + Date.now().toString().slice(-8));
    const bufferQR = await gerarQRCodeBuffer(payload);

    await humanReply(m, {
        content: ` **PAGAMENTO DA SALA** \n\n **Valor:** R$ ${valorPix.toFixed(2)}\n **Favorecido:** ${nomeDestino}\n **Chave:** ${chaveDestino}\n\n **Copia e Cola o código abaixo:**\n\`${payload}\``,
        files: [new MessageAttachment(bufferQR, 'qrcode_pix.png')],
    });
}

async function handlePgr(m, _txtRaw, client) {
    const chaveDestino = config.pix.chave;
    const nomeDestino = config.pix.nome;
    const txid = 'PGR' + Date.now().toString().slice(-8);

    const payload = gerarPayloadPix(chaveDestino, nomeDestino, 'SAO PAULO', 0, txid);
    const bufferQR = await gerarQRCodeBuffer(payload);

    await humanReply(m, {
        content:
            ` **COBRANÇA PIX** \n\n` +
            ` **Favorecido:** ${nomeDestino}\n` +
            ` **Chave:** ${chaveDestino}\n\n` +
            ` **Copia e Cola o código abaixo:**\n\`${payload}\``,
        files: [new MessageAttachment(bufferQR, 'qrcode_pix.png')],
    });
}

async function handleMenu(m) {
    await humanReply(m,
        `##  MENU DE COMANDOS — SalaBotPro\n\n` +
        `###  Comandos Públicos\n` +
        `\`.infoinfo\` — Explica como funciona o bot de salas\n\n` +
        `###  Pagamento (dentro de filas/partidas)\n` +
        `\`Pg Nome Sobrenome\` — Confirma seu pagamento\n` +
        `\`Pago Nome Sobrenome\` — Confirma seu pagamento\n` +
        `\`Nome Sobrenome Pg\` — Confirma seu pagamento\n\n` +
        `### ️ Comandos do Dono\n` +
        `\`.menu\` — Mostra este menu\n` +
        `\`.cpg Nome Sobrenome\` — **Confirma pagamento por outra pessoa**\n` +
        `\`.pgr\` — Gera QR Code PIX automático com valor da fila\n` +
        `\`.status\` — Mostra saúde do bot (memória, filas, conexões)\n` +
        `\`.lucro\` — Relatório de faturamento (hoje + total)\n` +
        `\`.verificar Nome Sobrenome\` — Busca manual de pagamento\n` +
        `\`.pix [chave] [valor]\` — Gera QR Code PIX (customizável)\n` +
        `\`.rv\` — Solicita revanche na fila atual\n` +
        `\`.rv inf\` — Revanche forçando **Gel Infinito**\n` +
        `\`.rv capa\` — Revanche forçando **Full Capa**\n` +
        `\`.go <ID>\` — Confirma que está pronto. Quando ambos confirmarem, inicia a partida\n` +
        `\`.reconectar\` — Força reconexão do Telegram\n\n` +
        `\n**Comandos Diretos no Telegram (só lá no Telegram):**\n` +
        `\`+cs\` — Cria sala **Padrão Apostado**\n` +
        `\`+cs 2\` — Cria sala **Gel Infinito**\n` +
        `\`+cs 3\` — Cria sala **Full Capa**\n\n` +
        `###  Painel Web\n` +
        `Acesse o Dashboard para controlar o bot, ver logs e estatísticas em tempo real.`
    );
}

async function handleConfirmarPagamento(m, txtRaw, client) {
    const nome = txtRaw.replace('.cpg', '').trim();
    if (!nome) {
        const cpgMsgs = [' Usa: `.cpg Nome Sobrenome`', ' Faltou o nome. Ex: `.cpg Carlos Eduardo`', ' Preciso do nome completo.'];
        await humanReply(m, pick(cpgMsgs));
        return;
    }

    const fila = state.filasPagamento.get(m.channel.id);
    if (!fila || fila.salaCriada) {
        const flMsgs = [' Não tem fila ativa aqui.', ' Nenhuma fila neste canal.', ' Sem fila aberta nessa thread.'];
        await humanReply(m, pick(flMsgs));
        return;
    }

    const txtSintetico = `pg ${nome}`.toLowerCase();
    await paymentLogic.processar(m, txtSintetico, client, { eMediador: true });
}

async function handleGo(m, txtRaw, client) {
    if (!goService) return;

    const channelId = m.channel.id;
    let canalTemSala = false;
    for (const [, sala] of goService.salasAtivas) {
        if (sala.threadId === channelId) { canalTemSala = true; break; }
    }
    if (!canalTemSala) return;

    const args = txtRaw.replace('.go', '').trim();
    if (!args) {
        try { await m.reply(pick(MSGS.goSemId)); } catch (_) { }
        return;
    }

    const salaID = args.split(' ')[0];

    const resultado = goService.confirmarGo(salaID, m.author.id, channelId);

    let msgFinal = resultado.mensagem;
    if (resultado.status === 'erro') {
        if (resultado.mensagem.includes('Aguarde alguns segundos')) {
            msgFinal = pick(MSGS.goCooldown);
        } else if (resultado.mensagem.includes('não encontrei') || resultado.mensagem.includes('Não encontrei')) {
            msgFinal = pick(MSGS.goNaoEncontrada)(salaID);
        } else if (resultado.mensagem.includes('expirou')) {
            msgFinal = pick(MSGS.goExpirada);
        } else if (resultado.mensagem.includes('já foi iniciada')) {
            msgFinal = pick(MSGS.goJaIniciada);
        } else if (resultado.mensagem.includes('canal da fila')) {
            return;
        } else if (resultado.mensagem.includes('já confirmou')) {
            msgFinal = pick(MSGS.goJaConfirmou);
        }
    } else if (resultado.status === 'ok') {
        const matchCount = resultado.mensagem.match(/(\d+)\/(\d+)/);
        const atual = matchCount ? matchCount[1] : '1';
        const total = matchCount ? matchCount[2] : '2';
        msgFinal = pick(MSGS.goConfirmado)(salaID, atual, total);
    } else if (resultado.status === 'ambos') {
        msgFinal = pick(MSGS.goAmbos)(salaID);
    }

    try { await m.reply(msgFinal); } catch (err) { }

    if (resultado.status === 'ambos') {
        const sala = goService.getSala(salaID);
        const confirmados = sala ? [...sala.confirmados] : [];
        const jogadores = sala?.jogadores || null;

        let painelAtualizado = false;
        try {
            const roomPanelService = require('../../services/roomPanelService');
            painelAtualizado = await roomPanelService.atualizarPainelDeSala(salaID, client);
        } catch (_) {}

        if (!painelAtualizado) {
            try {
                await new Promise(r => setTimeout(r, 1000));
                let painelTexto;

                if (jogadores && (jogadores.equipe1.length > 0 || jogadores.equipe2.length > 0)) {
                    const total = jogadores.equipe1.length + jogadores.equipe2.length;
                    painelTexto = `## ️ SALA CRIADA!\n\n`;
                    painelTexto += `**Equipe 1:**\n`;
                    for (const j of jogadores.equipe1) {
                        painelTexto += `│ ${j.tipo} ${j.nome} (${j.id})\n`;
                    }
                    if (jogadores.equipe1.length === 0) painelTexto += `│ _Ninguém_\n`;
                    painelTexto += `\n**Equipe 2:**\n`;
                    for (const j of jogadores.equipe2) {
                        painelTexto += `│ ${j.tipo} ${j.nome} (${j.id})\n`;
                    }
                    if (jogadores.equipe2.length === 0) painelTexto += `│ _Ninguém_\n`;
                    painelTexto += `\n **${total}** jogadores`;
                } else {
                    painelTexto =
                        ` **PARTIDA INICIANDO** • Sala ${salaID}\n\n` +
                        ` **TIME 1**\n` +
                        `> Slot 1 — <@${confirmados[0] || '???'}> \n` +
                        `> Slot 2 — Ninguém\n` +
                        `> Slot 3 — Ninguém\n` +
                        `> Slot 4 — Ninguém\n\n` +
                        ` **TIME 2**\n` +
                        `> Slot 1 — <@${confirmados[1] || '???'}> \n` +
                        `> Slot 2 — Ninguém\n` +
                        `> Slot 3 — Ninguém\n` +
                        `> Slot 4 — Ninguém\n\n` +
                        ` **${confirmados.length}/8** jogadores`;
                }
                await m.channel.send(painelTexto);
            } catch (err) { }
        }

        if (telegramForceStart) {
            try {
                await new Promise(r => setTimeout(r, randomDelay(1000, 2000)));
                const tgResult = await telegramForceStart.forcarInicio(salaID, sala?.tgMsgId || null);
                await m.channel.send(tgResult.mensagem);
            } catch (err) { }
        }
    }
}

const PUBLIC_COMMANDS = {};

const PUBLIC_PREFIX_COMMANDS = [
    { prefix: '.go', handler: handleGo },
];

const OWNER_COMMANDS = {
    '.infoinfo': handleInfo,
    '.menu': handleMenu,
    '.pgr': handlePgr,
    '.status': handleStatus,
    '.reconectar': handleReconectar,
    '.lucro': handleLucro,
};

const OWNER_PREFIX_COMMANDS = [
    { prefix: '.cpg', handler: handleConfirmarPagamento },
    { prefix: '.verificar', handler: handleVerificar },
    { prefix: '.pix', handler: handlePix },
    { prefix: '.rv', handler: handleRevanche },
];

async function processar(m, txtRaw, client) {
    const publicHandler = PUBLIC_COMMANDS[txtRaw];
    if (publicHandler) {
        await publicHandler(m, txtRaw, client);
        return true;
    }

    for (const cmd of PUBLIC_PREFIX_COMMANDS) {
        if (txtRaw.startsWith(cmd.prefix)) {
            await cmd.handler(m, txtRaw, client);
            return true;
        }
    }

    if (txtRaw === '.infoinfo') {
        await handleInfo(m, txtRaw, client);
        return true;
    }

    if (txtRaw.startsWith('.cpg')) {
        const isOwner = m.author.id === client.user.id;
        const isMediador = config.discord.cargoMediadorId
            && m.member?.roles?.cache?.has(config.discord.cargoMediadorId);

        if (isOwner || isMediador) {
            await handleConfirmarPagamento(m, txtRaw, client);
            return true;
        }
        return false;
    }

    if (m.author.id !== client.user.id) return false;

    const ownerHandler = OWNER_COMMANDS[txtRaw];
    if (ownerHandler) {
        await ownerHandler(m, txtRaw, client);
        return true;
    }

    for (const cmd of OWNER_PREFIX_COMMANDS) {
        if (txtRaw.startsWith(cmd.prefix)) {
            await cmd.handler(m, txtRaw, client);
            return true;
        }
    }

    return false;
}

module.exports = { processar };