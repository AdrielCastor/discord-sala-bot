const axios = require('axios');
const { log } = require('../logger');
const state = require('../state');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_TIMEOUT = 15000;

const _cache = new state.BoundedMap(30);
const CACHE_TTL = 3 * 60 * 1000;

const SYSTEM_PROMPT = `Você é o assistente oficial de regras de um servidor de apostas de Free Fire.

INSTRUÇÕES OBRIGATÓRIAS:
1. Leia TODAS as regras fornecidas abaixo com atenção.
2. Quando o jogador perguntar algo, procure a regra EXATA que responde a pergunta.
3. Responda SOMENTE com base nas regras. NÃO invente. NÃO extrapole.
4. Se a pergunta NÃO tem resposta nas regras, responda EXATAMENTE: "️ Não encontrei essa regra cadastrada. Aguarde um administrador confirmar."
5. Resposta CURTA (1-2 frases). DIRETA. OBJETIVA.
6. Use emojis:  = permitido,  = proibido/não pode, ️ = atenção,  = valores/taxas,  = informações.
7. NÃO repita a pergunta. Responda direto.

EXEMPLOS DE COMO RESPONDER:
- Pergunta: "pode colete 4?" → Procure nas regras sobre colete → " Sim, colete nível 4 é permitido."
- Pergunta: "vale mp40?" → Procure nas regras sobre armas → " Sim, MP40 é permitida em todos os rounds."
- Pergunta: "pode subir escada?" → Procure nas regras sobre escada → Responda o que diz a regra.
- Pergunta: "vale granada?" → Procure nas regras sobre granada → Responda conforme a regra.
- Se não achar na lista de regras → "️ Não encontrei essa regra cadastrada. Aguarde um administrador confirmar."

ATENÇÃO: Os jogadores podem usar gírias como "vale" (= é permitido?), "pode" (= é permitido?), "rola" (= é permitido?).`;

function normalizarParaCache(texto) {
    return texto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[?!.,;:'"()]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function interpretarPergunta(guildId, pergunta, regrasTexto) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        log('️', '[GROQ] GROQ_API_KEY não configurada no .env');
        return null;
    }

    if (!regrasTexto || regrasTexto.trim().length < 20) {
        return null;
    }

    const cacheKey = `${guildId}:${normalizarParaCache(pergunta)}`;
    const cached = _cache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
        log('', `[GROQ] Cache hit: "${pergunta.substring(0, 40)}"`);
        return cached.resposta;
    }

    const messages = [
        {
            role: 'system',
            content: SYSTEM_PROMPT + '\n\n═══════ REGRAS COMPLETAS DA ORGANIZAÇÃO ═══════\n\n' + regrasTexto.substring(0, 8000)
        },
        {
            role: 'user',
            content: pergunta
        }
    ];

    try {
        log('', `[GROQ] Consultando IA: "${pergunta.substring(0, 50)}"`);

        const response = await axios.post(GROQ_API_URL, {
            model: GROQ_MODEL,
            messages: messages,
            temperature: 0.15,
            max_tokens: 200,
            top_p: 0.85,
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: GROQ_TIMEOUT
        });

        const resposta = response.data?.choices?.[0]?.message?.content;

        if (resposta) {
            _cache.set(cacheKey, { resposta: resposta.trim(), ts: Date.now() });
            log('', `[GROQ] Resposta: "${resposta.trim().substring(0, 100)}"`);
            return resposta.trim();
        }

        log('️', '[GROQ] Resposta vazia da API');
        return null;

    } catch (err) {
        if (err.response) {
            log('', `[GROQ] Erro API: ${err.response.status} — ${JSON.stringify(err.response.data?.error?.message || err.response.statusText)}`);
        } else if (err.code === 'ECONNABORTED') {
            log('⏱️', '[GROQ] Timeout na chamada');
        } else {
            log('', `[GROQ] Erro: ${err.message}`);
        }
        return null;
    }
}

async function gerarResposta(guildId, pergunta, regrasTexto, matchLocal) {
    if (matchLocal) {
        log('', `[GROQ] Match local encontrado (score: ${(matchLocal.score * 100).toFixed(0)}%), mas mandando regras COMPLETAS para IA`);
    }

    const resp = await interpretarPergunta(guildId, pergunta, regrasTexto);
    if (resp) return resp;

    if (matchLocal && matchLocal.bloco) {
        return ' ' + matchLocal.bloco.substring(0, 300);
    }

    return '️ Não encontrei essa regra cadastrada. Aguarde um administrador confirmar.';
}

module.exports = {
    interpretarPergunta,
    gerarResposta,
};
