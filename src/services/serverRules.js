const fs = require('fs');
const path = require('path');
const { log } = require('../logger');
const state = require('../state');

const RULES_PATH = path.join(process.cwd(), 'serverrules.json');
let regras = {};
const _cooldowns = new state.BoundedMap(100);

let _saveTimer = null;

function salvarRegrasDebounced() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(RULES_PATH, JSON.stringify(regras, null, 2), 'utf-8');
            log('', '[SERVER-RULES] Regras salvas com sucesso.');
        } catch (err) {
            log('', `[SERVER-RULES] Erro ao salvar: ${err.message}`);
        }
        _saveTimer = null;
    }, 300);
}

function carregarRegras() {
    try {
        if (fs.existsSync(RULES_PATH)) {
            const raw = fs.readFileSync(RULES_PATH, 'utf-8');
            regras = JSON.parse(raw || '{}');
            if (typeof regras !== 'object' || Array.isArray(regras)) regras = {};
        } else {
            regras = {};
            fs.writeFileSync(RULES_PATH, '{}', 'utf-8');
        }
        const qtdOrgs = Object.keys(regras).length;
        log('', `[SERVER-RULES] Regras carregadas! ${qtdOrgs} organização(ões).`);
    } catch (err) {
        log('️', `[SERVER-RULES] Erro ao carregar: ${err.message}. Iniciando vazio.`);
        regras = {};
    }
}

function normalizar(texto) {
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

function setRegrasOrg(guildId, config) {
    regras[guildId] = config;
    salvarRegrasDebounced();
}

function parsearBlocos(textoRegras) {
    if (!textoRegras) return [];

    const linhas = textoRegras.split('\n');
    const blocos = [];
    let blocoAtual = [];

    for (const linha of linhas) {
        const trimmed = linha.trim();
        if (!trimmed) {
            if (blocoAtual.length > 0) {
                blocos.push(blocoAtual.join('\n').trim());
                blocoAtual = [];
            }
        } else {
            blocoAtual.push(trimmed);
        }
    }
    if (blocoAtual.length > 0) {
        blocos.push(blocoAtual.join('\n').trim());
    }

    return blocos.filter(b => b.length > 5);
}

const _stopwords = new Set([
    'pode', 'posso', 'vale', 'qual', 'quanto', 'como', 'quando', 'quem',
    'tem', 'ter', 'que', 'pra', 'para', 'com', 'sem', 'por', 'de', 'do',
    'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma',
    'uns', 'umas', 'ou', 'e', 'se', 'ja', 'tb', 'tbm', 'eh', 'ai',
    'usar', 'fazer', 'ir', 'ser', 'estar', 'foi', 'era', 'sao',
    'sim', 'nao', 'tipo', 'hj', 'aq', 'pq', 'oq', 'ta',
    'permitido', 'proibido', 'liberado', 'autorizado',
]);

function extrairTermos(texto) {
    const norm = normalizar(texto);
    return norm.split(' ').filter(t => t.length > 1 && !_stopwords.has(t));
}

function buscarRegraLocal(guildId, pergunta) {
    const orgConfig = regras[guildId];
    if (!orgConfig || !orgConfig.regrasTexto || !orgConfig.ativo) return null;

    const blocos = parsearBlocos(orgConfig.regrasTexto);
    if (blocos.length === 0) return null;

    const termos = extrairTermos(pergunta);
    if (termos.length === 0) return null;

    let melhorBloco = null;
    let melhorScore = 0;

    for (const bloco of blocos) {
        const blocoNorm = normalizar(bloco);
        let score = 0;

        for (const termo of termos) {
            if (blocoNorm.includes(termo)) {
                score++;
                if (blocoNorm.substring(0, 60).includes(termo)) {
                    score += 0.5;
                }
            }
        }

        const scoreProporcional = score / termos.length;

        if (scoreProporcional > melhorScore && scoreProporcional >= 0.4) {
            melhorScore = scoreProporcional;
            melhorBloco = bloco;
        }
    }

    if (melhorBloco) {
        log('', `[SERVER-RULES] Match local! Score: ${(melhorScore * 100).toFixed(0)}% | Bloco: "${melhorBloco.substring(0, 60)}..."`);
        return { bloco: melhorBloco, score: melhorScore };
    }

    return null;
}

const PERGUNTA_PATTERNS = [
    /^vale\s+\w/i,
    /^pode\s+\w/i,
    /^posso\s+\w/i,
    /^rola\s+\w/i,
    /^libera\s+\w/i,
    /^aceita\s+\w/i,
    /^permite\s+\w/i,
    /^proibido\s+\w/i,
    /^liberado\s+\w/i,
    /^e permitido\b/i,
    /^eh permitido\b/i,
    /^e proibido\b/i,
    /^e liberado\b/i,
    /^eh liberado\b/i,
    /^pode usar\b/i,
    /^pode subir\b/i,
    /^pode trocar\b/i,
    /\b(colete|capacete|capa|granada|awm|mp40|m1014|shotgun|ump|p90|scar|famas|ak|m4a1|m79|escada|buggy|carro|veiculo|moto|gel|gelo|martelo|skill|habilidade|personagem|pet)\b.*\?/i,
    /^qual\s+(level|nivel|lv)\b/i,
    /^quanto\s+(paga|custa|cobra)\b/i,
    /\bdesist/i,
    /\bwo\b/i,
    /\bw\.o\b/i,
    /^vale\s+.+\s+adm/i,
    /^pode\s+.+\s+adm/i,
    /^.+\s+vale\s*[\?!]*$/i,
];

function limparPergunta(texto) {
    return texto
        .replace(/\s*adm[\s?!]*$/i, '?')
        .replace(/\s*rei[\s?!]*$/i, '?')
        .trim();
}

function ehPerguntaSobreRegras(texto) {
    const norm = normalizar(texto);
    if (norm.length < 5 || norm.length > 200) return false;

    if (norm.includes('pg ') || norm.includes('pagamento') || norm.includes('pix')) return false;
    if (norm.match(/^\d+[.,]\d{2}$/)) return false;

    if (norm.match(/^adm\s*(on|online|aqui)?[\s?!]*$/)) return false;

    if (norm.startsWith('.') || norm.startsWith('!') || norm.startsWith('+')) return false;

    if (norm.match(/^(oi|ola|eae|eai|salve|fala|bom dia|boa tarde|boa noite|obrigado|vlw|valeu|blz|beleza|ok|sim|nao|tmj|flw|falou)/)) return false;

    return PERGUNTA_PATTERNS.some(p => p.test(norm));
}

function verificarCooldown(guildId, userId, channelId) {
    const orgConfig = regras[guildId];
    const cooldownMs = orgConfig?.cooldownMs || 30000;
    const key = `rules:${guildId}:${userId}:${channelId}`;
    const ultimo = _cooldowns.get(key);
    const agora = Date.now();
    if (ultimo && (agora - ultimo) < cooldownMs) return true;
    return false;
}

function registrarCooldown(guildId, userId, channelId) {
    const key = `rules:${guildId}:${userId}:${channelId}`;
    _cooldowns.set(key, Date.now());
}

module.exports = {
    carregarRegras,
    getRegrasOrg,
    setRegrasOrg,
    buscarRegraLocal,
    ehPerguntaSobreRegras,
    limparPergunta,
    verificarCooldown,
    registrarCooldown,
    normalizar,
    parsearBlocos,
};
