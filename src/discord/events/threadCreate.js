const fs = require('fs').promises;
const path = require('path');
const { MessageAttachment } = require('discord.js-selfbot-v13');
const { log } = require('../../logger');
const state = require('../../state');
const config = require('../../config');
const { humanSend } = require('../helpers');
let threadMsgConfig = null;
try { threadMsgConfig = require('../../services/threadMessageConfig'); } catch (_) { }

function detectarModo(nomeThread) {
    const n = nomeThread.toLowerCase();
    if (n.includes('gel inf') || n.includes('gelo inf') || n.includes('infinito') || (n.includes('infinitooo') && !n.includes('infinitooo'))) {
        return 'gel_infinito';
    }
    return null;
}

async function detectarModoDoCanal(channel) {
    try {
        const msgs = await channel.messages.fetch({ limit: 15 });
        for (const [, msg] of msgs) {
            const texto = (msg.content || '').toLowerCase();
            const modo = detectarModo(texto);
            if (modo) return modo;

            if (msg.embeds?.length > 0) {
                for (const embed of msg.embeds) {
                    const embedTexto = [
                        embed.title || '',
                        embed.description || '',
                        ...(embed.fields || []).map(f => `${f.name} ${f.value}`),
                        embed.footer?.text || '',
                    ].join(' ').toLowerCase();

                    const modoEmbed = detectarModo(embedTexto);
                    if (modoEmbed) return modoEmbed;
                }
            }
        }
    } catch (e) {
        log('️', `[MODO] Erro ao buscar mensagens do canal: ${e.message}`);
    }
    return '4x4_apostado';
}

function canalEstaPagar(nome) {
    return (nome || '').toLowerCase().includes('pagar');
}

function canalValidoParaFila(nome) {
    const n = (nome || '').toLowerCase();
    if (canalEstaPagar(n)) return false;
    return n.includes('fila') || n.includes('privado') || n.includes('partida');
}

let cacheExemploPng = null;
let cacheProibidoPng = null;

async function carregarCacheImagens() {
    try { cacheExemploPng = await fs.readFile(path.join(process.cwd(), 'exemplo.png')); } catch (_) { }
    try { cacheProibidoPng = await fs.readFile(path.join(process.cwd(), 'bancoproibido.png')); } catch (_) { }
}

async function enviarInstrucoes(channelId, fila, client, opts = {}) {
    try {
        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
        const nomeCanal = channel?.name?.toLowerCase() || '';

        if (canalEstaPagar(nomeCanal)) return;

        if (!opts.skipValidacao) {
            if (nomeCanal.includes('partida')) return;
            if (!nomeCanal.includes('fila') && !nomeCanal.includes('privado')) return;
        } 
        
        await new Promise(resolve => setTimeout(resolve, 5000));

        const chCached = client.channels.cache.get(channelId);
        const nomeAtualizado = (chCached?.name || channel.name || '').toLowerCase();
        if (canalEstaPagar(nomeAtualizado)) return;

        const msgCustom = threadMsgConfig?.getMensagemCustom?.();
        if (msgCustom) {
            let textoFinal = msgCustom;
            if (threadMsgConfig.deveIncluirPix()) {
                const pixChave = threadMsgConfig.getPixChave() || '';
                if (pixChave) {
                    textoFinal += `\n\n\uD83D\uDCB3 **Chave PIX:** \`${pixChave}\``;
                }
            }
            await humanSend(channel, textoFinal, { skipDelay: true, skipTyping: true });
        } else {
            const instrMsgs = [
                `## \u26a0\ufe0f CRIA\u00c7\u00c3O DAS SALAS AUTOM\u00c1TICAS\n\n` +
                `PRA SALA SER CRIADA BASTA DIZER **"Pago Nome Sobrenome"**\n` +
                `PODE SER EM QUALQUER ORDEM: **"Nome Sobrenome Pg"** TAMB\u00c9M FUNCIONA\n` +
                `N\u00c3O USE VIRGULAS OU PONTOS, N\u00c3O PRECISA DIZER O BANCO.\n\n` +
                `A sala vai ser criada automaticamente, basta dizer igual no exemplo abaixo:`,

                `## \u26a0\ufe0f SALAS AUTOM\u00c1TICAS\n\n` +
                `Pra criar a sala \u00e9 simples: manda **"Pg Nome Sobrenome"**\n` +
                `Tamb\u00e9m funciona: **"Nome Sobrenome Pago"**\n` +
                `Sem v\u00edrgula, sem ponto, sem nome do banco.\n\n` +
                `Segue o exemplo:`,

                `## \u26a0\ufe0f ATEN\u00c7\u00c3O \u2014 SALAS AUTOM\u00c1TICAS\n\n` +
                `Pra sala sair, manda: **"Pago Nome Sobrenome"**\n` +
                `A ordem n\u00e3o importa, **"Nome Sobrenome Pg"** tamb\u00e9m vale\n` +
                `N\u00e3o coloca v\u00edrgula nem ponto, n\u00e3o precisa falar o banco.\n\n` +
                `Olha o exemplo abaixo:`,
            ];
            const pick = arr => arr[Math.floor(Math.random() * arr.length)];
            await humanSend(channel, pick(instrMsgs), { skipDelay: true, skipTyping: true });
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        if (cacheExemploPng) {
            try {
                await humanSend(channel, null, {
                    files: [new MessageAttachment(cacheExemploPng, 'exemplo.png')],
                    skipTyping: true,
                    skipDelay: true
                });
            } catch (_) { }

            if (cacheProibidoPng) {
                await new Promise(resolve => setTimeout(resolve, 500));
                try {
                    await humanSend(channel, null, {
                        files: [new MessageAttachment(cacheProibidoPng, 'bancoproibido.png')],
                        skipTyping: true,
                        skipDelay: true
                    });
                } catch (_) { }
            }
        }
    } catch (e) {
        log('️', `Erro ao enviar instruções: ${e.message}`);
    }
}

function pararFilaSePagar(thread) {
    const nome = thread.name?.toLowerCase() || '';
    if (!canalEstaPagar(nome)) return false;
    log('', `[PAGAR] Canal bloqueado: ${thread.name}`);
    return true;
}

async function registrarFila(thread, client) {
    if (pararFilaSePagar(thread)) return;
    if (state.threadsRespondidas.has(thread.id)) return;
    const nome = thread.name.toLowerCase();
    if (!canalValidoParaFila(nome)) return;
    state.threadsRespondidas.add(thread.id);
    if (state.filasPagamento.has(thread.id)) return;

    let modo = detectarModo(nome);
    if (!modo) {
        try {
            const channel = await client.channels.fetch(thread.id);
            modo = await detectarModoDoCanal(channel);
        } catch (_) {
            modo = '4x4_apostado';
        }
    }

    let valorDaThread = null;
    const matchValor = thread.name.match(/(\d+)[.,](\d{2})/);

    if (matchValor) {
        const v = parseFloat(`${matchValor[1]}.${matchValor[2]}`);
        if (v >= 0.50 && v <= 100) {
            valorDaThread = v;
        }
    }

    const ehPartida = nome.includes('partida');

    state.filasPagamento.set(thread.id, {
        confirmados: new Set(),
        confirmadosUserId: new Set(),
        pagamentosUsados: [],
        valor: valorDaThread,
        valorOriginal: valorDaThread,
        valorBase: null,
        infinito: modo === 'gel_infinito',
        modo,
        instrucoesEnviadas: !ehPartida,
        salaCriada: false,
        criadaEm: Date.now(),
    });

    if (!ehPartida) {
        const fila = state.filasPagamento.get(thread.id);
        if (fila) enviarInstrucoes(thread.id, fila, client);
    }
}

function registrar(client) {
    carregarCacheImagens();

    client.on('threadCreate', async (thread) => {
        if (!thread?.id) return;
        if (config.discord.guildId && thread.guild?.id !== config.discord.guildId) return;

        let tentativas = 0;
        const maxTentativas = 24;

        const verificarThread = async () => {
            try {
                const threadAtualizada = await thread.fetch();
                const nomeAtual = threadAtualizada.name?.toLowerCase() || '';

                if (canalEstaPagar(nomeAtual)) {
                    pararFilaSePagar(threadAtualizada);
                    return true;
                }

                if (canalValidoParaFila(nomeAtual)) {
                    registrarFila(threadAtualizada, client);
                    return true;
                }

                return false;
            } catch (e) {
                const msgError = (e.message || String(e)).toLowerCase();
                if (!msgError.includes('unknown channel')) {
                    log('️', `Erro ao atualizar thread ${thread.id}: ${e.message || e}`);
                }
                return false;
            }
        };

        const jaResolveu = await verificarThread();
        if (jaResolveu) return;

        const agendarProxima = () => {
            tentativas++;
            if (tentativas >= maxTentativas) return;
            state.startTrackedTimeout(async () => {
                const resolveu = await verificarThread();
                if (!resolveu) agendarProxima();
            }, 2000);
        };
        agendarProxima();
    });

    client.on('threadUpdate', async (oldThread, newThread) => {
        if (!newThread?.id || !newThread?.name) return;
        const nome = newThread.name.toLowerCase();

        if (canalEstaPagar(nome)) {
            pararFilaSePagar(newThread);
            return;
        }

        if (!canalValidoParaFila(nome)) return;

        const fila = state.filasPagamento.get(newThread.id);
        if (fila && !fila.instrucoesEnviadas && nome.includes('fila') && !nome.includes('partida')) {
            fila.instrucoesEnviadas = true;
            enviarInstrucoes(newThread.id, fila, client, { skipValidacao: true });
        }

        registrarFila(newThread, client);
    });
}

module.exports = { registrar, enviarInstrucoes, carregarCacheImagens, detectarModo, detectarModoDoCanal };