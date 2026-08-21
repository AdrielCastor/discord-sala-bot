const axios = require('axios');
const state = require('../../state');
const config = require('../../config');
const { log } = require('../../logger');

const {
    sanitizar,
    extrairValorDaString,
    detectouPago,
    normalizarNome,
    nomeConfere,
    limparNomeDoPagamento,
} = require('../../utils');

const { enviarInstrucoes } = require('./threadCreate');
const { replyAndDelete, humanReply } = require('../helpers');
const adminCommands = require('../commands/admin');
const paymentLogic = require('../commands/payment');
const { extrairDadosDeImagem } = require('../../services/gmailPixService');

const { TIMINGS } = state;
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const ANTIFRAUDE_TTL_MS = 10 * 60 * 1000;
const ANTIFRAUDE_MAX_ENTRIES = 100;

const AntifraudGuard = {
    _locks: new state.BoundedMap(ANTIFRAUDE_MAX_ENTRIES),

    claim(nomeNormalizado, userId, nomeOriginal) {
        const existing = this._locks.get(nomeNormalizado);

        if (existing && existing.userId !== userId && !this._isExpired(existing)) {
            return false;
        }

        this._locks.set(nomeNormalizado, {
            userId,
            timestamp: Date.now(),
            nome: nomeOriginal,
        });

        state.startTrackedTimeout(() => {
            this._locks.delete(nomeNormalizado);
        }, ANTIFRAUDE_TTL_MS);

        return true;
    },

    check(nomeNormalizado, userId) {
        for (const [, info] of this._locks.entries()) {
            if (info.userId === userId || this._isExpired(info)) continue;
            if (nomeConfere(nomeNormalizado, info.nome)) {
                return { blocked: true, owner: info.userId };
            }
        }
        return { blocked: false };
    },

    _isExpired(entry) {
        return (Date.now() - entry.timestamp) >= ANTIFRAUDE_TTL_MS;
    },
};

function canalEstaPagar(nomeCanal) {
    return (nomeCanal || '').toLowerCase().includes('pagar');
}

function bloquearCanalPagar(m) {
    const nomeCanal = (m.channel.name || '').toLowerCase();
    if (!canalEstaPagar(nomeCanal)) return false;
    log('', `[PAGAR] Canal bloqueado: "${m.channel.name}" (${m.channel.id})`);
    return true;
}

async function baixarImagemComoBase64(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000,
        });
        return Buffer.from(response.data).toString('base64');
    } catch (err) {
        log('️', `[OCR] Falha ao baixar imagem: ${err.message}`);
        return null;
    }
}

function filtrarImagens(attachments) {
    return [...attachments.values()].filter(att =>
        att.contentType?.startsWith('image/') ||
        /\.(png|jpg|jpeg|webp|bmp)$/i.test(att.name || '')
    );
}

async function processarComprovanteOCR(m, fila, client) {
    if (bloquearCanalPagar(m)) return;

    if (!process.env.OCR_API_KEY) {
        const ocrMsgs = [
            '️ OCR não tá ativo. Manda: `Pg Nome Sobrenome`',
            '️ Sem OCR configurado. Usa: `Pago Nome Sobrenome`',
            '️ Leitura de imagem indisponível. Digita: `Pg Nome Sobrenome`',
        ];
        return replyAndDelete(m, client, pick(ocrMsgs), TIMINGS.DELETE_DELAY_MEDIUM_MS);
    }

    const imagens = filtrarImagens(m.attachments);

    if (imagens.length === 0) {
        const noImgMsgs = [
            '️ Não vi imagem nenhuma. Manda: `Pg Nome Sobrenome`',
            '️ Cadeia a imagem? Envia: `Pago Nome Sobrenome`',
            '️ Nenhuma imagem detectada. Usa: `Pg Nome Sobrenome`',
        ];
        return replyAndDelete(m, client, pick(noImgMsgs), TIMINGS.DELETE_DELAY_MEDIUM_MS);
    }

    const ocrReadMsgs = [
        ' **Lendo comprovante...** Aguarde.',
        ' **Analisando a imagem...** Já já.',
        ' **Conferindo o comprovante...** Espera.',
    ];
    const msgProcessando = await humanReply(m, pick(ocrReadMsgs));

    let nomeExtraido = null;
    let valorExtraido = null;

    for (const imagem of imagens) {
        const base64 = await baixarImagemComoBase64(imagem.url || imagem.proxyURL);
        if (!base64) continue;

        const { nome, valor } = await extrairDadosDeImagem(base64, imagem.contentType || 'image/png');

        if (nome) {
            nomeExtraido = nome;
            valorExtraido = valor || null;
            break;
        }
    }

    if (msgProcessando) {
        msgProcessando.delete().catch(() => { });
    }

    if (!nomeExtraido) {
        const failMsgs = [
            ' Não consegui ler esse comprovante.',
            ' A imagem não ficou legível. Tenta de novo.',
            ' Não deu pra extrair os dados da imagem.',
        ];
        return replyAndDelete(m, client, pick(failMsgs), TIMINGS.DELETE_DELAY_LONG_MS);
    }

    const nomeLimpo = normalizarNome(nomeExtraido);

    if (!AntifraudGuard.claim(nomeLimpo, m.author.id, nomeExtraido)) {
        const usedMsgs = [
            '️ Esse comprovante já foi usado.',
            '️ Já vi esse comprovante antes.',
            '️ Comprovante repetido.',
        ];
        return replyAndDelete(m, client, pick(usedMsgs), TIMINGS.DELETE_DELAY_MEDIUM_MS);
    }

    log('', `[OCR FILA] ${nomeExtraido}`);
    const txtSintetico = `pg ${nomeExtraido}`.toLowerCase();
    await paymentLogic.processar(m, txtSintetico, client);
}

function registrar(client) {
    const KNOWN_DOT_CMDS = ['.go', '.rv', '.pix', '.pgr', '.cpg', '.menu', '.status', '.reconectar', '.lucro', '.verificar', '.infoinfo'];

    client.on('messageCreate', async (m) => {
        if (config.discord.guildId && m.guild?.id !== config.discord.guildId) return;

        const isBotMsg = m.author.bot;
        const txtRaw = sanitizar(m.content || '', 2000).toLowerCase().trim();

        if (!isBotMsg) {
            if (txtRaw.startsWith('.') && !KNOWN_DOT_CMDS.some(c => txtRaw.startsWith(c))) {
                return;
            }
        }

        const ehComandoPermitidoPagar =
            txtRaw.startsWith('.go') ||
            txtRaw.startsWith('.rv') ||
            txtRaw.startsWith('.pix') ||
            txtRaw === '.pgr';

        const _nomeCanal = (m.channel.name || '').toLowerCase();
        const _ehPagar = _nomeCanal.includes('pagar');

        if (!ehComandoPermitidoPagar && _ehPagar) return;

        if (!isBotMsg) {
            const handled = await adminCommands.processar(m, txtRaw, client);
            if (handled) return;
        }

        const isThread = m.channel.isThread?.() || false;
        const isTextChannel = [0, 5, 10, 11, 12, 15].includes(m.channel.type);
        const ehFilaOuPrivado = _nomeCanal.includes('fila') || _nomeCanal.includes('privado') || _nomeCanal.includes('partida');

        if (!isThread && !isTextChannel && !ehFilaOuPrivado) return;

        if (ehFilaOuPrivado && !_ehPagar && !state.filasPagamento.has(m.channel.id)) {
            const jaRespondeu = state.threadsRespondidas.has(m.channel.id);
            const _ehPartida = _nomeCanal.includes('partida');

            state.filasPagamento.set(m.channel.id, {
                confirmados: new Set(),
                confirmadosUserId: new Set(),
                pagamentosUsados: [],
                valor: null,
                valorOriginal: null,
                valorBase: null,
                infinito: false,
                modo: '4x4_apostado',
                instrucoesEnviadas: !_ehPartida,
                salaCriada: false,
                criadaEm: Date.now(),
            });

            const filaRef = state.filasPagamento.get(m.channel.id);
            const { detectarModo, detectarModoDoCanal } = require('./threadCreate');

            let modo = typeof detectarModo === 'function' ? detectarModo(_nomeCanal) : null;
            if (!modo) {
                try {
                    modo = await detectarModoDoCanal(m.channel);
                } catch (_) {
                    modo = '4x4_apostado';
                }
            }

            filaRef.modo = modo;
            filaRef.infinito = modo === 'gel_infinito';

            const matchValor = (m.channel.name || '').match(/(\d+)[.,](\d{2})/);
            if (matchValor) {
                const v = parseFloat(`${matchValor[1]}.${matchValor[2]}`);
                if (v >= 0.50 && v <= 100) {
                    filaRef.valor = v;
                    filaRef.valorOriginal = v;
                }
            }

            if (!jaRespondeu && !_ehPartida) {
                state.threadsRespondidas.add(m.channel.id);
                enviarInstrucoes(m.channel.id, filaRef, client);
            } else if (!jaRespondeu) {
                state.threadsRespondidas.add(m.channel.id);
            }
        }

        if (_nomeCanal.includes('partida') && !_nomeCanal.includes('fila')) return;

        const fila = state.filasPagamento.get(m.channel.id);
        if (!fila || fila.salaCriada) return;

        if (_nomeCanal.includes('fila') && !fila.instrucoesEnviadas) {
            fila.instrucoesEnviadas = true;
            enviarInstrucoes(m.channel.id, fila, client, { skipValidacao: true });
        }

        if (!ehComandoPermitidoPagar && _ehPagar) return;

        {
            let valorDetectado = null;
            const conteudo = m.content || '';
            if (conteudo.length > 0) {
                valorDetectado = extrairValorDaString(conteudo);
            }

            if (!valorDetectado && m.embeds && m.embeds.length > 0) {
                for (const embed of m.embeds) {
                    const textoEmbed = [
                        embed.title || '',
                        embed.description || '',
                        ...(embed.fields || []).map(f => `${f.name} ${f.value}`),
                        embed.footer?.text || '',
                    ].join(' ');
                    valorDetectado = extrairValorDaString(textoEmbed);
                    if (valorDetectado) break;
                }
            }

            if (valorDetectado) {
                if (isBotMsg) {
                    fila.valorOriginal = valorDetectado;
                    fila.valor = valorDetectado;
                    fila.valorTravado = true;
                } else if (!fila.valorTravado) {
                    if (fila.valorOriginal == null || fila.valorOriginal <= 0) {
                        fila.valor = valorDetectado;
                    }
                }
            }
        }

        if (isBotMsg) return;
        if (m.author.id === client.user.id) return;

        if (state.mensagensProcessadas.has(m.id)) return;
        state.mensagensProcessadas.add(m.id);

        const temPago = detectouPago(txtRaw);

        if (!ehComandoPermitidoPagar && _ehPagar) return;

        if (m.attachments.size > 0 && !temPago) {
            return processarComprovanteOCR(m, fila, client);
        }

        if (!m.content || !temPago) return;

        const nomeLimpo = normalizarNome(limparNomeDoPagamento(txtRaw));

        if (nomeLimpo && nomeLimpo.length >= 3) {
            const { blocked } = AntifraudGuard.check(nomeLimpo, m.author.id);
            if (blocked) {
                const blkMsgs = ['️ Nome bloqueado.', '️ Esse nome tá bloqueado.', '️ Não posso aceitar esse nome.'];
                return replyAndDelete(m, client, pick(blkMsgs), TIMINGS.DELETE_DELAY_MEDIUM_MS);
            }
        }

        if (!ehComandoPermitidoPagar && _ehPagar) return;

        await paymentLogic.processar(m, txtRaw, client);
    });
}

module.exports = { registrar };