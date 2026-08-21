const state = require('../state');
const { TIMINGS } = state;

const ZWSP = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF'];

function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function variarTexto(texto) {
    if (!texto) return texto;
    let resultado = texto;
    const numInserts = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < numInserts; i++) {
        const pos = Math.floor(Math.random() * resultado.length);
        const char = ZWSP[Math.floor(Math.random() * ZWSP.length)];
        resultado = resultado.slice(0, pos) + char + resultado.slice(pos);
    }
    return resultado;
}

function checkRateLimit(channelId) {
    const agora = Date.now();
    let registro = state._rateLimitMap.get(channelId);

    if (!registro) {
        registro = { msgs: [], inicio: agora };
        state._rateLimitMap.set(channelId, registro);
    }

    registro.msgs = registro.msgs.filter(ts => (agora - ts) < TIMINGS.RATE_LIMIT_WINDOW_MS);

    if (registro.msgs.length >= TIMINGS.RATE_LIMIT_MSGS) {
        return { limited: true, extraDelay: TIMINGS.RATE_LIMIT_WINDOW_MS + randomDelay(500, 1500) };
    }

    const extraDelay = registro.msgs.length >= 2 ? randomDelay(2000, 5000) : 0;
    registro.msgs.push(agora);
    return { limited: false, extraDelay };
}

async function humanSend(channel, texto, opts = {}) {
    if (!state.statusConexoes.discord) return null;

    try {
        const channelId = channel.id || channel;

        const rl = checkRateLimit(channelId);

        if (!opts.skipDelay) {
            const baseDelay = randomDelay(TIMINGS.HUMAN_DELAY_MIN_MS, TIMINGS.HUMAN_DELAY_MAX_MS);
            const jitter = randomDelay(0, 300);
            await new Promise(r => setTimeout(r, baseDelay + rl.extraDelay + jitter));
        }

        if (rl.limited) {
            await new Promise(r => setTimeout(r, rl.extraDelay));
        }

        const skipTypingChance = Math.random() < 0.2;
        if (!opts.skipTyping && !opts.files && !skipTypingChance) {
            try {
                await channel.sendTyping();
                const textoLen = (texto || '').length;
                const typingBase = randomDelay(TIMINGS.HUMAN_TYPING_MIN_MS, TIMINGS.HUMAN_TYPING_MAX_MS);
                const typingExtra = Math.min(textoLen * 5, 1500);
                await new Promise(r => setTimeout(r, typingBase + typingExtra));
            } catch (_) { }
        }

        const textoFinal = (!opts.skipVariation && texto) ? variarTexto(texto) : texto;

        const payload = opts.files
            ? { content: textoFinal, files: opts.files }
            : textoFinal;

        const msg = await channel.send(payload);
        return msg;

    } catch (err) {
        return null;
    }
}

async function humanReply(m, texto, opts = {}) {
    if (!state.statusConexoes.discord) return null;

    try {
        const channelId = m.channel.id;

        const rl = checkRateLimit(channelId);

        if (!opts.skipDelay) {
            const baseDelay = randomDelay(TIMINGS.HUMAN_DELAY_MIN_MS, TIMINGS.HUMAN_DELAY_MAX_MS);
            const jitter = randomDelay(0, 300);
            await new Promise(r => setTimeout(r, baseDelay + rl.extraDelay + jitter));
        }

        if (rl.limited) {
            await new Promise(r => setTimeout(r, rl.extraDelay));
        }

        const skipTypingChance = Math.random() < 0.2;
        if (!opts.skipTyping && !opts.files && !skipTypingChance) {
            try {
                await m.channel.sendTyping();
                const textoStr = typeof texto === 'string' ? texto : (texto?.content || '');
                const textoLen = textoStr.length;
                const typingBase = randomDelay(TIMINGS.HUMAN_TYPING_MIN_MS, TIMINGS.HUMAN_TYPING_MAX_MS);
                const typingExtra = Math.min(textoLen * 5, 1500);
                await new Promise(r => setTimeout(r, typingBase + typingExtra));
            } catch (_) { }
        }

        const textoFinal = (!opts.skipVariation && texto && typeof texto === 'string') ? variarTexto(texto) : texto;

        const payload = (opts.files && typeof textoFinal === 'string')
            ? { content: textoFinal, files: opts.files }
            : textoFinal;

        const msg = await m.reply(payload);
        return msg;

    } catch (err) {
        return null;
    }
}

function agendarDeleteMsg(client, channelId, msgId, delayMs) {
    state.startTrackedTimeout(async () => {
        try {
            const ch = client.channels.cache.get(channelId);
            if (!ch) return;
            const msg = await ch.messages.fetch(msgId);
            await msg.delete();
        } catch (_) { }
    }, delayMs);
}

async function replyAndDelete(m, client, texto, delayMs) {
    if (!state.statusConexoes.discord) return null;
    try {
        const msg = await humanReply(m, texto, { skipVariation: true });
        if (msg) {
            agendarDeleteMsg(client, msg.channel.id, msg.id, delayMs);
        }
        return msg;
    } catch (err) {
        return null;
    }
}

module.exports = { agendarDeleteMsg, replyAndDelete, humanSend, humanReply, randomDelay };
