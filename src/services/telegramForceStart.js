const config = require('../config');
const { log } = require('../logger');
const state = require('../state');

const BOTAO_FORCE_START = [
    'forçar início',
    'forçar inicio',
    'forçar início da partida',
    'forçar inicio da partida',
    'force start',
    'iniciar partida',
    'forcar inicio',
    'start',
];

async function forcarInicio(salaID, tgMsgId = null) {
    const tg = state.telegram;
    if (!tg) {
        log('', `[FORCE-START] Telegram não conectado!`);
        return { sucesso: false, mensagem: ' Telegram não está conectado.' };
    }

    const alvo = config.telegram.alvo;
    if (!alvo) {
        log('', `[FORCE-START] config.telegram.alvo não configurado!`);
        return { sucesso: false, mensagem: ' Chat do Telegram não configurado.' };
    }

    try {
        log('', `[FORCE-START] Buscando sala ${salaID} no Telegram...`);

        const mensagens = await tg.getMessages(alvo, { limit: 30 });
        if (!mensagens || mensagens.length === 0) {
            log('️', `[FORCE-START] Nenhuma mensagem encontrada.`);
            return { sucesso: false, mensagem: '️ Não encontrei mensagens no chat do Telegram.' };
        }

        let msgAlvo = null;

        if (tgMsgId) {
            msgAlvo = mensagens.find(msg => msg.id === tgMsgId);
            if (msgAlvo) {
                log('', `[FORCE-START] Mensagem encontrada por ID do TG: ${tgMsgId}`);
            }
        }

        if (!msgAlvo) {
            for (const msg of mensagens) {
                const texto = (msg.message || msg.text || '').toLowerCase();
                if (texto.includes(salaID) || texto.includes(`id: ${salaID}`) || texto.includes(`id:${salaID}`)) {
                    msgAlvo = msg;
                    log('', `[FORCE-START] Mensagem encontrada por texto contendo "${salaID}"`);
                    break;
                }
            }
        }

        if (!msgAlvo) {
            log('️', `[FORCE-START] Não encontrei mensagem com sala ${salaID}.`);
            return { sucesso: false, mensagem: `️ Não encontrei a sala ${salaID} no Telegram.` };
        }

        const botoes = await msgAlvo.getButtons();
        if (!botoes || botoes.length === 0) {
            log('️', `[FORCE-START] Mensagem da sala ${salaID} não tem botões.`);

            const resultado = await buscarBotaoProximo(mensagens, salaID, msgAlvo);
            if (resultado) return resultado;

            return { sucesso: false, mensagem: `️ A mensagem não tem botão de "Forçar início".` };
        }

        return await tentarClicar(msgAlvo, botoes, salaID);

    } catch (err) {
        log('', `[FORCE-START] Erro: ${err.message}`);
        return { sucesso: false, mensagem: ` Erro ao forçar início: ${err.message}` };
    }
}

async function buscarBotaoProximo(mensagens, salaID, msgOriginal) {
    const idxOriginal = mensagens.indexOf(msgOriginal);
    const inicio = Math.max(0, idxOriginal - 5);
    const fim = Math.min(mensagens.length, idxOriginal + 6);

    for (let i = inicio; i < fim; i++) {
        if (i === idxOriginal) continue;
        const msg = mensagens[i];
        try {
            const botoes = await msg.getButtons();
            if (botoes && botoes.length > 0) {
                const resultado = await tentarClicar(msg, botoes, salaID);
                if (resultado.sucesso) return resultado;
            }
        } catch (_) { }
    }

    return null;
}

async function tentarClicar(msg, botoes, salaID) {
    const todosBotoes = [];
    for (const row of botoes) {
        for (const b of row) {
            if (b.text) todosBotoes.push(b.text);
        }
    }
    log('', `[FORCE-START] Botões encontrados: [${todosBotoes.join(' | ')}]`);

    for (let i = 0; i < botoes.length; i++) {
        for (let j = 0; j < botoes[i].length; j++) {
            const botao = botoes[i][j];
            const textoBtn = (botao.text || '').toLowerCase();

            const match = BOTAO_FORCE_START.some(t => textoBtn.includes(t));
            if (match) {
                log('', `[FORCE-START] Clicando em "${botao.text}" para sala ${salaID}!`);
                await msg.click(i, j);
                log('', `[FORCE-START] Botão "${botao.text}" clicado com sucesso!`);
                return {
                    sucesso: true,
                    mensagem: ` **Partida forçada com sucesso!** Sala ${salaID} iniciada.`
                };
            }
        }
    }

    log('️', `[FORCE-START] Nenhum botão "Forçar início" encontrado.`);
    return {
        sucesso: false,
        mensagem: `️ Encontrei a sala ${salaID} mas não há botão "Forçar início" disponível.`
    };
}

module.exports = {
    forcarInicio,
};
