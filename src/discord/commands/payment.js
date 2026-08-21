const config = require('../../config');
const { log } = require('../../logger');
const state = require('../../state');
const db = require('../../database');
const { normalizarNome, nomeConfere, limparNomeDoPagamento } = require('../../utils');
const { agendarDeleteMsg, replyAndDelete, humanReply, humanSend, randomDelay } = require('../helpers');

const { TIMINGS, REGRAS } = state;

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function obterValorExigido(fila) {
    if (fila.valorOriginal != null && fila.valorOriginal > 0) {
        return fila.valorOriginal;
    }
    if (fila.valor != null && fila.valor > 0) {
        return fila.valor;
    }
    return 0;
}

function travarValorOriginal(fila, valor) {
    if (fila.valorOriginal != null && fila.valorOriginal > 0) {
        return;
    }
    fila.valorOriginal = valor;
}

async function processar(m, txtRaw, client) {
    if (!state.botRodando) return;

    const fila = state.filasPagamento.get(m.channel.id);
    if (!fila || fila.salaCriada) return;

    try {
        const nome = normalizarNome(limparNomeDoPagamento(txtRaw));

        if (!nome || nome.length < REGRAS.NOME_MIN_LENGTH) {
            const nmMsgs = [
                ' Manda seu nome completo junto. Ex: `Pg Nome Sobrenome`',
                ' Faltou o nome! Usa: `Pago Nome Sobrenome`',
                ' Preciso do seu nome completo pra confirmar.',
            ];
            return replyAndDelete(m, client, pick(nmMsgs), TIMINGS.DELETE_DELAY_MEDIUM_MS);
        }

        const lockKey = `${m.channel.id}-${m.author.id}-${nome}`;
        if (state.usuariosProcessando.has(lockKey)) return;
        state.usuariosProcessando.add(lockKey);
        state.startTrackedTimeout(() => state.usuariosProcessando.delete(lockKey), TIMINGS.LOCK_TIMEOUT_MS);

        if (fila.confirmados?.has(nome)) {
            state.usuariosProcessando.delete(lockKey);
            const dupMsgs = ['️ Esse nome já foi confirmado.', '️ Esse pagamento já entrou.', '️ Já registrei esse nome nessa fila.'];
            return replyAndDelete(m, client, pick(dupMsgs), TIMINGS.DELETE_DELAY_SHORT_MS);
        }

        let valorExigido = obterValorExigido(fila);

        if (valorExigido <= 0) {
            const pgPreview = buscarPagamentosDisponiveis(nome);
            if (pgPreview.length > 0) {
                valorExigido = pgPreview[0].valor;
                travarValorOriginal(fila, valorExigido);
                fila.valor = valorExigido;
            } else {
                valorExigido = 0;
            }
        }

        const pagamentosLivres = buscarPagamentosDisponiveis(nome);

        if (pagamentosLivres.length > 0) {
            if (valorExigido <= 0) {
                valorExigido = pagamentosLivres[0].valor;
                travarValorOriginal(fila, valorExigido);
                fila.valor = valorExigido;
            }
            return processarResultado(pagamentosLivres, valorExigido, m, fila, client);
        }

        await aguardarPagamento(nome, valorExigido, m, fila, client);

    } catch (errPg) {
        log('', `[PG] Erro CRÍTICO: ${errPg.message}`);
        try { await m.reply(' Ocorreu um erro ao processar seu pagamento. Tente novamente.'); } catch (_) { }
    }
}

function buscarPagamentosDisponiveis(nomeNormalizado) {
    return state.pagamentosRecentes.filter(
        p => p.filaUsada === null && nomeConfere(nomeNormalizado, p.nomeCompleto)
    );
}

async function aguardarPagamento(nome, valorExigido, m, fila, client) {
    const waitMsgs = [
        ' **Verificando pagamento...** Aguarde.',
        ' **Buscando seu pagamento...** Já já sai.',
        ' **Conferindo no banco...** Espera um pouco.',
    ];
    const msgAguarde = await humanReply(m, pick(waitMsgs), { skipVariation: true });

    for (let i = 0; i < TIMINGS.RETRY_MAX_TENTATIVAS; i++) {
        await new Promise(r => setTimeout(r, TIMINGS.RETRY_INTERVAL_MS));

        const filaAtual = state.filasPagamento.get(m.channel.id);
        if (!filaAtual || filaAtual.salaCriada) {
            if (msgAguarde) msgAguarde.delete().catch(() => { });
            return;
        }

        const valorAtual = obterValorExigido(filaAtual);
        const valParaUsar = valorAtual > 0 ? valorAtual : valorExigido;

        const encontrados = buscarPagamentosDisponiveis(nome);
        if (encontrados.length > 0) {
            if (msgAguarde) msgAguarde.delete().catch(() => { });
            return processarResultado(encontrados, valParaUsar, m, filaAtual, client);
        }
    }

    if (msgAguarde) msgAguarde.delete().catch(() => { });
    const toMsgs = [
        ' Pagamento não encontrado. Confere se o nome tá certo.',
        ' Não achei o pagamento. Verifica o nome digitado.',
        ' Nada encontrado. Tenta de novo com o nome certinho.',
    ];
    return replyAndDelete(m, client, pick(toMsgs), TIMINGS.DELETE_DELAY_MEDIUM_MS);
}

async function processarResultado(pagamentos, valorExigido, m, fila, client) {
    pagamentos.sort((a, b) => a.horario - b.horario);

    if (pagamentos[0].proibido) {
        pagamentos[0].filaUsada = 'BLOQUEADO_REGRA';
        const banco = pagamentos[0].banco;
        const nome = pagamentos[0].nomeCompleto;
        const bancoMsgs = [
            ` **PAGAMENTO RECUSADO!**\n ${nome}\n Banco: **${banco}**\n\n️ Não aceitamos Banco Inter, Mercado Pago ou PicPay.`,
            ` **RECUSADO!**\n ${nome}\n **${banco}**\n\n️ Esse banco não é aceito aqui (Inter, MP, PicPay).`,
            ` **Pagamento barrado!**\n ${nome}\n **${banco}**\n\n️ Banco não permitido pelas regras do servidor.`,
        ];
        return replyAndDelete(m, client, pick(bancoMsgs), TIMINGS.DELETE_DELAY_LONG_MS);
    }

    let soma = 0;
    const usados = [];

    for (const p of pagamentos) {
        if (p.filaUsada !== null) continue;
        p.filaUsada = 'RESERVADO';
        soma += p.valor;
        usados.push(p);
        if (soma >= valorExigido) break;
    }

    const tolerancia = REGRAS.TOLERANCIA_TAXA_PIX || 0;
    if (valorExigido > 0 && soma < (valorExigido - tolerancia)) {
        usados.forEach(p => { p.filaUsada = null; });

        const falta = (valorExigido - soma).toFixed(2).replace('.', ',');
        const valExig = valorExigido.toFixed(2).replace('.', ',');
        const valEnv = soma.toFixed(2).replace('.', ',');

        const incMsgs = [
            ` **Pagamento incompleto!** Fila custa **R$ ${valExig}**, você enviou **R$ ${valEnv}**. Faltam **R$ ${falta}**.`,
            ` **Valor insuficiente!** Precisava de **R$ ${valExig}**, chegou **R$ ${valEnv}**. Falta **R$ ${falta}**.`,
            ` **Faltou dinheiro!** A cota é **R$ ${valExig}** e veio só **R$ ${valEnv}**. Faltam **R$ ${falta}**.`,
        ];
        return replyAndDelete(m, client, pick(incMsgs), TIMINGS.DELETE_DELAY_LONG_MS);
    }

    if (valorExigido > 0) {
        travarValorOriginal(fila, valorExigido);
    }

    await finalizarPagamento(m, fila, usados, soma, valorExigido, client);
}

async function finalizarPagamento(m, fila, pagamentosUsados, soma, valorExigido, client) {
    const nomeCliente = pagamentosUsados[0].nomeCompleto;
    const bancoCliente = pagamentosUsados[0].banco;
    const nomeNorm = normalizarNome(nomeCliente);

    if (fila.confirmados?.has(nomeNorm)) {
        pagamentosUsados.forEach(p => { p.filaUsada = null; });
        const lockKey = `${m.channel.id}-${m.author.id}-${nomeNorm}`;
        state.usuariosProcessando.delete(lockKey);
        return;
    }

    for (const p of pagamentosUsados) {
        p.filaUsada = m.channel.id;
        fila.pagamentosUsados.push(p.id);
    }

    fila.confirmados.add(nomeNorm);
    state.tentativasFalhas.delete(m.author.id);

    const lockKey = `${m.channel.id}-${m.author.id}-${nomeNorm}`;
    state.usuariosProcessando.delete(lockKey);

    const totalConfirmados = fila.confirmados.size;
    const totalNecessarios = REGRAS.CONFIRMACOES_PARA_SALA;

    db.inserirPagamento(nomeCliente, soma, m.channel.name).catch(() => {});

    const nomeCanalAtual = (m.channel.name || '').toLowerCase();
    if (nomeCanalAtual.includes('pagar')) return;

    if (totalConfirmados < totalNecessarios) {
        const progMsgs = pagamentosUsados.length > 1 ? [
            ` Pagamentos agrupados!\n ${nomeCliente}\n ${bancoCliente}\n Total: R$${soma.toFixed(2)}\n\n **${totalConfirmados}/${totalNecessarios} pagamentos confirmados**`,
            ` Agrupei os pagamentos!\n ${nomeCliente}\n ${bancoCliente}\n R$${soma.toFixed(2)} aprovado\n\n **${totalConfirmados}/${totalNecessarios} pagamentos confirmados**`,
        ] : [
            ` Pagamento confirmado\n ${nomeCliente}\n ${bancoCliente}\n R$${soma.toFixed(2)}\n\n **${totalConfirmados}/${totalNecessarios} pagamentos confirmados**`,
            ` Confirmado!\n ${nomeCliente}\n ${bancoCliente}\n R$${soma.toFixed(2)}\n\n **${totalConfirmados}/${totalNecessarios} confirmados**`,
            ` Pix recebido!\n ${nomeCliente}\n ${bancoCliente}\n R$${soma.toFixed(2)}\n\n **${totalConfirmados}/${totalNecessarios} confirmados**`,
        ];
        await humanReply(m, pick(progMsgs));
    } else {
        const confMsgs = pagamentosUsados.length > 1 ? [
            ` Pagamentos agrupados!\n ${nomeCliente}\n ${bancoCliente}\n Total: R$${soma.toFixed(2)}`,
            ` Agrupei os pagamentos!\n ${nomeCliente}\n ${bancoCliente}\n R$${soma.toFixed(2)} aprovado`,
        ] : [
            ` Pagamento confirmado\n ${nomeCliente}\n ${bancoCliente}\n R$${soma.toFixed(2)}`,
            ` Confirmado!\n ${nomeCliente}\n ${bancoCliente}\n R$${soma.toFixed(2)}`,
            ` Pix recebido!\n ${nomeCliente}\n ${bancoCliente}\n R$${soma.toFixed(2)}`,
        ];
        await humanReply(m, pick(confMsgs));
    }

    if (state.io) {
        state.io.emit('nova-venda', {
            nome: nomeCliente,
            valor: soma,
            banco: bancoCliente,
            fila: m.channel.name,
        });
    }

    if (config.discord.logChannelId && config.discord.logChannelId !== 'COLE_O_ID_DO_CANAL_AQUI') {
        try {
            const canalLog = await client.channels.fetch(config.discord.logChannelId);
            await humanSend(canalLog,
                `🟢 **PAGAMENTO APROVADO** 🟢\n` +
                ` **Cliente:** ${nomeCliente}\n` +
                ` **Valor:** R$ ${soma.toFixed(2)}\n` +
                ` **Fila:** <#${m.channel.id}>\n` +
                ` **Progresso:** ${totalConfirmados}/${totalNecessarios}\n` +
                `⏰ **Data:** <t:${Math.floor(Date.now() / 1000)}:f>`
            );
        } catch (e) { }
    }

    if (totalConfirmados >= totalNecessarios && !fila.salaCriada) {
        const channelId = m.channel.id;

        const salaExistente = state.salasAtivasPorCanal.get(channelId);
        if (salaExistente) {
            await humanSend(m.channel, `️ Esse canal já tem uma sala ativa (**${salaExistente}**). Aguarde o término antes de criar outra.`);
            return;
        }

        if (state._criacaoSalaLocks.has(channelId)) return;
        state._criacaoSalaLocks.add(channelId);

        const agora = Date.now();
        const ultimaCriacao = state.cooldownBotaoSala.get(channelId);
        if (ultimaCriacao && (agora - ultimaCriacao) < 30000) {
            state._criacaoSalaLocks.delete(channelId);
            return;
        }
        state.cooldownBotaoSala.set(channelId, agora);

        fila.salaCriada = true;

        const salaMsgs = [
            ` **${totalNecessarios}/${totalNecessarios} pagamentos confirmados! Criando sala...**`,
            ` **Tudo certo! ${totalNecessarios}/${totalNecessarios} pagamentos recebidos, solicitando sala...**`,
            ` **Pronto! ${totalNecessarios}/${totalNecessarios} confirmados. Sala a caminho...**`,
        ];
        await humanSend(m.channel, pick(salaMsgs));

        const modoSala = fila.modo || '4x4_apostado';
        const comandoMap = { 'gel_infinito': '+cs 2', 'capa': '+cs 3' };

        const jaEnfileirado = state.threadsAguardandoSala.some(t => t.id === channelId);
        if (jaEnfileirado) {
            state._criacaoSalaLocks.delete(channelId);
            return;
        }

        state.threadsAguardandoSala.push({
            id: channelId,
            infinito: fila.infinito || modoSala === 'gel_infinito',
            modo: modoSala,
            comandoTelegram: comandoMap[modoSala] || '+cs',
            criadoEm: Date.now(),
        });

        state.startTrackedTimeout(() => {
            if (state._criacaoSalaLocks.has(channelId)) {
                state._criacaoSalaLocks.delete(channelId);
            }
        }, 120000);
    }
}

module.exports = { processar };
