const fs = require('fs');
const path = require('path');
const { log } = require('../logger');
const state = require('../state');

const AUTORESPONDER_PATH = path.join(process.cwd(), 'autoresponder.json');

let regras = {};
const _cooldowns = new state.BoundedMap(100);

let _saveTimer = null;

function salvarRegrasDebounced() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(AUTORESPONDER_PATH, JSON.stringify(regras, null, 2), 'utf-8');
            log('', '[AUTO-RESPONDER] Regras salvas com sucesso.');
        } catch (err) {
            log('', `[AUTO-RESPONDER] Erro ao salvar regras: ${err.message}`);
        }
        _saveTimer = null;
    }, 300);
}

function carregarRegras() {
    try {
        if (fs.existsSync(AUTORESPONDER_PATH)) {
            const raw = fs.readFileSync(AUTORESPONDER_PATH, 'utf-8');
            regras = JSON.parse(raw || '{}');
            if (typeof regras !== 'object' || Array.isArray(regras)) regras = {};
        } else {
            regras = {};
            fs.writeFileSync(AUTORESPONDER_PATH, '{}', 'utf-8');
        }
        const qtdOrgs = Object.keys(regras).length;
        log('', `[AUTO-RESPONDER] Regras carregadas! ${qtdOrgs} organização(ões) configurada(s).`);
    } catch (err) {
        log('️', `[AUTO-RESPONDER] Erro ao carregar regras: ${err.message}. Iniciando vazio.`);
        regras = {};
    }
}

function normalizarTexto(texto) {
    return texto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[?!.,;:'"()]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getRegrasOrg(guildId) {
    return regras[guildId] || null;
}

function setRegrasOrg(guildId, novasRegras) {
    if (novasRegras?.admOn) delete novasRegras.admOn._keywordsNorm;
    regras[guildId] = novasRegras;
    salvarRegrasDebounced();
}

function getRegrasPadrao() {
    return {
        categoriaId: '',
        admOn: {
            ativo: true,
            palavrasChave: [
                'adm on',
                'adm online',
                'tem adm',
                'admin on',
                'cade adm',
                'suporte on',
                'adm on?',
                'admin online',
                'cade o adm',
                'tem adm on',
            ],
            resposta: ' Adm SEMPRE ON.',
            cooldownMs: 60000,
        },
    };
}

function canalDentroDaCategoria(channel, categoriaId) {
    if (!categoriaId) return false;

    if (channel.parentId === categoriaId) return true;

    if (channel.parent && channel.parent.parentId === categoriaId) return true;

    try {
        const parent = channel.parent;
        if (parent) {
            if (parent.parentId === categoriaId) return true;
            if (parent.id === categoriaId) return true;
        }
    } catch (_) { }

    return false;
}

function verificarAutoResposta(guildId, userId, channelId, texto, channel) {
    const orgRegras = regras[guildId];
    if (!orgRegras) return null;

    const categoriaId = orgRegras.categoriaId;

    if (categoriaId && channel) {
        if (!canalDentroDaCategoria(channel, categoriaId)) return null;
    }

    const regra = orgRegras.admOn;
    if (!regra || !regra.ativo) return null;

    const textoNorm = normalizarTexto(texto);
    if (!textoNorm) return null;

    if (!regra._keywordsNorm) {
        regra._keywordsNorm = regra.palavrasChave
            .map(k => normalizarTexto(k))
            .filter(k => k && k.length > 0);
    }

    const match = regra._keywordsNorm.some(keyNorm => textoNorm.includes(keyNorm));

    if (!match) return null;

    const cooldownKey = `${guildId}:${userId}:${channelId}`;
    const ultimaResposta = _cooldowns.get(cooldownKey);
    const agora = Date.now();

    if (ultimaResposta && (agora - ultimaResposta) < (regra.cooldownMs || 60000)) {
        return null;
    }

    _cooldowns.set(cooldownKey, agora);

    log('', `[AUTO-RESPONDER] Match! User: ${userId} | Canal: ${channelId} | Texto: "${texto.substring(0, 50)}"`);
    return regra.resposta || ' Adm SEMPRE ON.';
}

module.exports = {
    carregarRegras,
    getRegrasOrg,
    setRegrasOrg,
    getRegrasPadrao,
    verificarAutoResposta,
    normalizarTexto,
};
