const { log } = require('../logger');
const state = require('../state');

const salasAtivas = new Map();
const _cooldowns = new state.BoundedMap(50);
const COOLDOWN_MS = 5000;
const EXPIRACAO_MS = 45 * 60 * 1000;
const CONFIRMACOES_NECESSARIAS = 2;

function registrarSala(salaID, senha, threadId, tgMsgId = null) {
    const salaAntiga = salasAtivas.get(salaID);
    if (salaAntiga && salaAntiga.threadId) {
        state.salasAtivasPorCanal.delete(salaAntiga.threadId);
    }
    salasAtivas.delete(salaID);

    salasAtivas.set(salaID, {
        salaID,
        senha,
        threadId,
        confirmados: new Set(),
        criadaEm: Date.now(),
        iniciada: false,
        tgMsgId,
        jogadores: null,
        modo: null,
        saldo: null,
        resultado: null,
        horaInicio: null,
    });

    if (threadId && threadId !== 'telegram_direct') {
        state.salasAtivasPorCanal.set(threadId, salaID);
        log('', `[GO] Canal ${threadId} mapeado → sala ${salaID}`);
    }

    state._criacaoSalaLocks.delete(threadId);

    log('', `[GO] Sala ${salaID} registrada! Thread: ${threadId}`);

    if (salasAtivas.size > 50) {
        const primeira = salasAtivas.keys().next().value;
        const salaRemovida = salasAtivas.get(primeira);
        if (salaRemovida && salaRemovida.threadId) {
            state.salasAtivasPorCanal.delete(salaRemovida.threadId);
        }
        salasAtivas.delete(primeira);
    }
}

function confirmarGo(salaID, userId, channelId) {
    const agora = Date.now();
    const ultimoUso = _cooldowns.get(userId);
    if (ultimoUso && (agora - ultimoUso) < COOLDOWN_MS) {
        return { status: 'erro', mensagem: ' Aguarde alguns segundos antes de usar `.go` novamente.' };
    }
    _cooldowns.set(userId, agora);

    const sala = salasAtivas.get(salaID);
    if (!sala) {
        log('️', `[GO] Sala ${salaID} não encontrada. User: ${userId}`);
        return { status: 'erro', mensagem: ` Não encontrei nenhuma fila com o ID **${salaID}**.` };
    }

    if ((agora - sala.criadaEm) > EXPIRACAO_MS) {
        salasAtivas.delete(salaID);
        log('⏰', `[GO] Sala ${salaID} expirada.`);
        return { status: 'erro', mensagem: '️ A confirmação dessa sala expirou.' };
    }

    if (sala.iniciada) {
        return { status: 'erro', mensagem: '️ Essa partida já foi iniciada.' };
    }

    if (sala.threadId !== channelId && sala.threadId !== 'telegram_direct') {
        log('️', `[GO] Sala ${salaID} pertence à thread ${sala.threadId}`);
        return { status: 'erro', mensagem: ' Use o comando `.go` no canal da fila correspondente.' };
    }

    if (sala.confirmados.has(userId)) {
        return { status: 'erro', mensagem: '️ Você já confirmou essa partida. Aguarde o outro jogador.' };
    }

    sala.confirmados.add(userId);
    const faltam = CONFIRMACOES_NECESSARIAS - sala.confirmados.size;

    log('', `[GO] Confirmação: User ${userId} | Sala ${salaID} | Confirmados: ${sala.confirmados.size}/${CONFIRMACOES_NECESSARIAS}`);

    if (sala.confirmados.size >= CONFIRMACOES_NECESSARIAS) {
        sala.iniciada = true;
        log('', `[GO] AMBOS CONFIRMARAM! Sala ${salaID}`);
        return {
            status: 'ambos',
            mensagem: ` **Ambos confirmaram a sala ${salaID}. Forçando início da partida...**`,
            salaID,
        };
    }

    return {
        status: 'ok',
        mensagem: ` Confirmação recebida para a sala **${salaID}**. Aguardando o outro jogador... (${sala.confirmados.size}/${CONFIRMACOES_NECESSARIAS})`,
    };
}

function getSala(salaID) {
    return salasAtivas.get(salaID) || null;
}

function getSalaByTgMsgId(tgMsgId) {
    if (!tgMsgId) return null;
    const searchId = typeof tgMsgId === 'string' ? tgMsgId.replace('edit_', '') : String(tgMsgId);
    for (const sala of salasAtivas.values()) {
        if (String(sala.tgMsgId) === searchId) {
            return sala;
        }
    }
    return null;
}

function limparSalasExpiradas() {
    const agora = Date.now();
    let removidas = 0;
    for (const [id, sala] of salasAtivas) {
        if ((agora - sala.criadaEm) > EXPIRACAO_MS) {
            if (sala.threadId) {
                state.salasAtivasPorCanal.delete(sala.threadId);
            }
            salasAtivas.delete(id);
            removidas++;
        }
    }
    if (removidas > 0) {
        log('', `[GO] ${removidas} sala(s) expirada(s) removida(s).`);
    }
}

module.exports = {
    registrarSala,
    confirmarGo,
    getSala,
    getSalaByTgMsgId,
    salasAtivas,
    limparSalasExpiradas,
};
