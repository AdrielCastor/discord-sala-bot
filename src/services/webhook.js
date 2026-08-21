const config = require('../config');
const { log } = require('../logger');
const { criarRegistroPix, detectarBanco } = require('../utils');
const state = require('../state');
const db = require('../database');

const RE_VALOR = /r\$\s*(\d+[.,]\d{2})/i;

const REGEX_NOME = [
    /Que\s+[óo]timo!\s*(.+?),\s*CPF/i,
    /valor\s+de\s+r\$\s?[\d.,]+\s+do\(a\)\s+(.+?)(?:\s*-\s*XXX|\s*-\s*\d|\s+XXX|\.|$|\n)/i,
    /valor\s+r\$\s?[\d.,]+\s+do\(a\)\s+(.+?)(?:\s*-\s*XXX|\s*-\s*\d|\s+XXX|\.|$|\n)/i,
    /do\(a\)\s+([^,]+),\s+no\s+valor\s+de\s+r\$\s?[\d.,]+\s+do\(a\)\s+(.+?)(?:\s*-\s*XXX|\s+XXX|\.|$|\n)/i,
    /r\$[\d.,]+\s+do\(a\)\s+(.+?)(?:\s*-\s*XXX|\s+XXX|\.|$|\n)/i,
    /r\$[\d.,]+\s+de\s+(.+?)(?:\.|$|\n)/i,
    /(.+?),\s*CPF\/CNPJ\s*.+?,\s*enviou/i,
];

let webhookRegistrado = false;

function registrarWebhookListener(client) {
    if (!config.discord.canalWebhookId) {
        log('️', 'Webhook Listener: Canal não configurado, ignorando.');
        return;
    }

    if (webhookRegistrado) {
        log('️', 'Webhook Listener: Já registrado, ignorando duplicata.');
        return;
    }

    webhookRegistrado = true;

    client.on('messageCreate', async (m) => {
        if (m.channel.id !== config.discord.canalWebhookId) return;
        if (!m.content) return;

        const textoOriginal = m.content;
        const texto = textoOriginal.toLowerCase();

        if (
            !texto.includes('pix') &&
            !texto.includes('transferência') &&
            !texto.includes('transferencia') &&
            !texto.includes('recebeu')
        ) return;

        log('', '[WEBHOOK DISCORD] Notificação da Caixa Recebida!');
        log('', `[CAIXA DEBUG TEXTO] ${textoOriginal}`);

        const valorMatch = texto.match(RE_VALOR);

        if (!valorMatch) {
            log('️', '[CAIXA] Sem valor na notificação.');
            return;
        }

        const valor = parseFloat(
            valorMatch[1]
                .replace(/\./g, '')
                .replace(',', '.')
        );

        if (!valor || valor <= 0) {
            log('️', '[CAIXA] Valor inválido.');
            return;
        }

        let nomeCompleto = null;

        for (const regex of REGEX_NOME) {
            const match = textoOriginal.match(regex);

            if (
                match &&
                (match[2] || match[1]) &&
                (match[2] || match[1]).trim().length >= 3
            ) {
                nomeCompleto = (match[2] || match[1])
                    .trim()
                    .replace(/\s+CPF.*$/i, '')
                    .replace(/\s+XXX.*$/i, '')
                    .replace(/\s*-\s*XXX.*$/i, '')
                    .replace(/\s+BANCO.*$/i, '')
                    .replace(/[.,;:]+$/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();

                break;
            }
        }

        if (!nomeCompleto || nomeCompleto.length < 3) {
            log('️', `[CAIXA] Valor achado (R$${valor.toFixed(2)}), mas nome falhou.`);
            return;
        }

        const { banco, proibido } = detectarBanco(texto);
        const bancoFinal = banco || 'CAIXA_WEBHOOK';

        const pixRecebido = criarRegistroPix(
            nomeCompleto,
            valor,
            bancoFinal,
            proibido
        );

        state.pagamentosRecentes.push(pixRecebido);
        state.indexarPagamento(pixRecebido);

        await db.salvarPendente(pixRecebido);

        log('', `[WEBHOOK CAIXA] Pix Salvo! ${nomeCompleto} | R$${valor.toFixed(2)}`);

        try {
            const canal = await client.channels.fetch(config.discord.canalWebhookId);

            if (canal) {
                await canal.send(
                    '```yaml\n' +
                    '🟦 PIX RECEBIDO COM SUCESSO! 🟦\n' +
                    ` Cliente: ${nomeCompleto}\n` +
                    ` Valor: R$${valor.toFixed(2)}\n` +
                    ` Banco: ${bancoFinal}\n` +
                    ` Horário: ${new Date(pixRecebido.horario).toLocaleTimeString('pt-BR')}\n` +
                    '```'
                );
            }
        } catch (err) {
            log('', `Erro ao enviar confirmação no Discord: ${err.message}`);
        }
    });

    log('', `Webhook Listener registrado no canal ${config.discord.canalWebhookId}`);
}

module.exports = { registrarWebhookListener };