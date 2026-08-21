const { log } = require('../logger');
const state = require('../state');

const _paineis = new Map();

function _salvarPainel(salaID, data) {
    if (_paineis.size >= 100) {
        const firstKey = _paineis.keys().next().value;
        _paineis.delete(firstKey);
    }
    _paineis.set(salaID, data);
}

function parseSaldoTelegram(text) {
    const match = text.match(/saldo\s*(?:restante|atual)?[:\s]+([\d.,]+)/i);
    if (match) {
        const saldoStr = match[1].replace(/\./g, '').replace(',', '.');
        const saldo = parseInt(saldoStr, 10);
        if (!isNaN(saldo) && saldo > 0) return saldo;
    }
    return null;
}

function parseDadosExtrasSala(originalText) {
    const modoMatch = originalText.match(/modo[:\s]+(.+?)(?:\n|$)/i);
    const inicioMatch = originalText.match(/in[ií]cio\s*autom[aá]tico[:\s]+(\d{1,2}\s*:\s*\d{2})/i);
    const saldo = parseSaldoTelegram(originalText);

    return {
        modo: modoMatch ? modoMatch[1].trim() : null,
        horaInicio: inicioMatch ? inicioMatch[1].trim() : null,
        saldo,
    };
}

function formatarSaldo(valor) {
    return String(valor).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function buildPainelTexto(salaData) {
    const {
        salaID,
        senha,
        modo,
        horaInicio,
        jogadores,
        saldo,
    } = salaData;

    let texto = ` **SALA CRIADA!**\n\n`;
    texto += ` **Modo:** ${modo || 'Padrão Apostado'}\n`;
    texto += ` **ID da Sala:** \`${salaID}\`\n`;
    texto += ` **Senha:** \`${senha}\`\n`;
    if (horaInicio) {
        texto += `⏰ **Início Automático:** \`${horaInicio}\`\n`;
    }

    texto += `\n---\n\n`;

    const totalJogadores = jogadores
        ? (jogadores.equipe1?.length || 0) + (jogadores.equipe2?.length || 0)
        : 0;

    texto += ` **Jogadores na Sala (${totalJogadores}/8)**\n`;

    if (totalJogadores === 0) {
        texto += `_Nenhum jogador entrou ainda._\n`;
    } else {
        texto += `**Equipe 1:**\n`;
        if (jogadores.equipe1 && jogadores.equipe1.length > 0) {
            for (const j of jogadores.equipe1) {
                texto += `│ ${j.tipo} ${j.nome} (${j.id})\n`;
            }
        } else {
            texto += `│ _Ninguém_\n`;
        }

        texto += `**Equipe 2:**\n`;
        if (jogadores.equipe2 && jogadores.equipe2.length > 0) {
            for (const j of jogadores.equipe2) {
                texto += `│ ${j.tipo} ${j.nome} (${j.id})\n`;
            }
        } else {
            texto += `│ _Ninguém_\n`;
        }
    }

    texto += `---\n`;

    if (saldo !== null && saldo !== undefined) {
        texto += ` **Saldo Atual:** ${formatarSaldo(saldo)} salas\n`;
        texto += ` Saldo suficiente para novas criações.\n`;
    } else {
        texto += ` **Saldo:** _Carregando..._\n`;
    }

    return texto;
}

async function criarPainel(channelId, salaID, discordClient) {
    const goService = require('./goCommandService');
    const sala = goService.getSala(salaID);
    if (!sala) {
        log('️', `[PAINEL] Sala ${salaID} não encontrada no registry.`);
        return null;
    }

    try {
        const channel = discordClient.channels.cache.get(channelId)
            || await discordClient.channels.fetch(channelId);
        if (!channel) {
            log('️', `[PAINEL] Canal ${channelId} não encontrado.`);
            return null;
        }

        const texto = buildPainelTexto({
            salaID: sala.salaID,
            senha: sala.senha,
            modo: sala.modo,
            horaInicio: sala.horaInicio,
            jogadores: sala.jogadores,
            saldo: sala.saldo,
        });

        let msg = null;
        try {
            msg = await channel.send(texto);
        } catch (sendErr) {
            log('️', `[PAINEL] Painel completo bloqueado pelo AutoMod: ${sendErr.message}. Tentando versão simplificada...`);
            try {
                const textoSimples =
                    ` **SALA CRIADA!**\n` +
                    ` ID: \`${sala.salaID}\` |  Senha: \`${sala.senha}\`\n` +
                    ` Modo: ${sala.modo || 'Padrão Apostado'}` +
                    (sala.horaInicio ? ` | ⏰ Início: \`${sala.horaInicio}\`` : '');
                msg = await channel.send(textoSimples);
                log('', `[PAINEL] Painel simplificado enviado para sala ${salaID}`);
            } catch (fallbackErr) {
                log('️', `[PAINEL] Fallback também falhou: ${fallbackErr.message}`);
                return null;
            }
        }

        if (msg) {
            _salvarPainel(salaID, {
                painelMsgId: msg.id,
                channelId: channelId,
            });
            log('', `[PAINEL] Painel criado para sala ${salaID} | MsgId: ${msg.id}`);

            try {
                await channel.send(` Para iniciar, os dois devem enviar: \`.go ${salaID}\``);
            } catch (goErr) {
                log('️', `[PAINEL] Erro ao enviar mensagem .go: ${goErr.message}`);
            }
        }

        return msg;
    } catch (err) {
        log('️', `[PAINEL] Erro ao criar painel: ${err.message}`);
        return null;
    }
}

async function atualizarPainelDeSala(salaID, discordClient) {
    const goService = require('./goCommandService');
    const sala = goService.getSala(salaID);
    if (!sala) return false;

    const painelInfo = _paineis.get(salaID);
    if (!painelInfo) return false;

    try {
        const channel = discordClient.channels.cache.get(painelInfo.channelId)
            || await discordClient.channels.fetch(painelInfo.channelId);
        if (!channel) return false;

        const msg = await channel.messages.fetch(painelInfo.painelMsgId);
        if (!msg) return false;

        const novoTexto = buildPainelTexto({
            salaID: sala.salaID,
            senha: sala.senha,
            modo: sala.modo,
            horaInicio: sala.horaInicio,
            jogadores: sala.jogadores,
            saldo: sala.saldo,
        });

        await msg.edit(novoTexto);

        log('', `[PAINEL] Painel atualizado para sala ${salaID}`);
        return true;
    } catch (err) {
        log('️', `[PAINEL] Erro ao atualizar painel: ${err.message}`);
        return false;
    }
}

function getPainelInfo(salaID) {
    return _paineis.get(salaID) || null;
}

module.exports = {
    parseSaldoTelegram,
    parseDadosExtrasSala,
    buildPainelTexto,
    criarPainel,
    atualizarPainelDeSala,
    getPainelInfo,
};
