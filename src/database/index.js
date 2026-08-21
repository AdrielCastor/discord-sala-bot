const fs = require('fs');
const path = require('path');
const { log } = require('../logger');

const FATURAMENTO_PATH = path.join(process.cwd(), 'faturamento.json');
const PENDENTES_PATH = path.join(process.cwd(), 'pendentes.json');

let pagamentos = [];
let pendentes = [];
let nextId = 1;

let _faturamentoTimer = null;
let _pendentesTimer = null;

function salvarFaturamentoDebounced() {
    if (_faturamentoTimer) clearTimeout(_faturamentoTimer);
    _faturamentoTimer = setTimeout(() => {
        try {
            fs.writeFileSync(FATURAMENTO_PATH, JSON.stringify(pagamentos), 'utf-8');
        } catch (err) {
            log('', `Erro ao salvar faturamento.json: ${err.message}`);
        }
        _faturamentoTimer = null;
    }, 300);
}

function salvarPendentesDebounced() {
    if (_pendentesTimer) clearTimeout(_pendentesTimer);
    _pendentesTimer = setTimeout(() => {
        try {
            fs.writeFileSync(PENDENTES_PATH, JSON.stringify(pendentes), 'utf-8');
        } catch (err) {
            log('', `Erro ao salvar pendentes.json: ${err.message}`);
        }
        _pendentesTimer = null;
    }, 300);
}

function inicializar() {
    return new Promise((resolve) => {
        try {
            if (fs.existsSync(FATURAMENTO_PATH)) {
                const raw = fs.readFileSync(FATURAMENTO_PATH, 'utf-8');
                pagamentos = JSON.parse(raw || '[]');
                if (!Array.isArray(pagamentos)) pagamentos = [];
            } else {
                pagamentos = [];
                fs.writeFileSync(FATURAMENTO_PATH, '[]', 'utf-8');
            }
        } catch (err) {
            log('️', `Erro ao ler faturamento.json: ${err.message}. Iniciando vazio.`);
            pagamentos = [];
        }

        try {
            if (fs.existsSync(PENDENTES_PATH)) {
                const raw = fs.readFileSync(PENDENTES_PATH, 'utf-8');
                pendentes = JSON.parse(raw || '[]');
                if (!Array.isArray(pendentes)) pendentes = [];
            } else {
                pendentes = [];
                fs.writeFileSync(PENDENTES_PATH, '[]', 'utf-8');
            }
        } catch (err) {
            log('️', `Erro ao ler pendentes.json: ${err.message}. Iniciando vazio.`);
            pendentes = [];
        }

        if (pagamentos.length > 0) {
            nextId = Math.max(...pagamentos.map(p => p.id || 0)) + 1;
        }

        log('️', `Banco JSON carregado! ${pagamentos.length} pagamentos + ${pendentes.length} pendentes.`);
        resolve();
    });
}

async function inserirPagamento(nome, valor, fila) {
    const registro = {
        id: nextId++,
        nome,
        valor,
        data: Date.now(),
        fila: fila || '',
    };
    pagamentos.push(registro);
    salvarFaturamentoDebounced();
    return registro;
}

async function getStats(tsHoje, taxaPorPessoa = 0.50) {
    let totalGeral = 0, qtdGeral = 0;
    let totalHoje = 0, qtdHoje = 0;
    let lucroGeral = 0, lucroHoje = 0;

    for (const p of pagamentos) {
        const v = p.valor || 0;
        totalGeral += v;
        qtdGeral++;
        lucroGeral += taxaPorPessoa;

        if (p.data >= tsHoje) {
            totalHoje += v;
            qtdHoje++;
            lucroHoje += taxaPorPessoa;
        }
    }

    return {
        totalGeral, qtdGeral, lucroGeral,
        totalHoje, qtdHoje, lucroHoje,
    };
}

async function getHistorico(limit = 100) {
    return pagamentos
        .slice(-limit)
        .reverse()
        .map(p => ({ nome: p.nome, valor: p.valor, data: p.data, fila: p.fila }));
}

async function getVendasPorHora(tsHoje) {
    const porHora = {};

    for (const p of pagamentos) {
        if (p.data < tsHoje) continue;
        const horaNum = Math.floor((p.data / 1000 - tsHoje / 1000) / 3600);
        const horaStr = String(horaNum).padStart(2, '0');

        if (!porHora[horaStr]) {
            porHora[horaStr] = { hora: horaStr, qtd: 0, total: 0 };
        }
        porHora[horaStr].qtd++;
        porHora[horaStr].total += p.valor || 0;
    }

    return Object.values(porHora).sort((a, b) => a.hora.localeCompare(b.hora));
}

async function salvarPendente(pix) {
    try {
        const idx = pendentes.findIndex(p => p.id === pix.id);
        const registro = {
            id: pix.id,
            nome: pix.nomeCompleto,
            nome_normalizado: pix.nomeNormalizado,
            valor: pix.valor,
            banco: pix.banco,
            horario: pix.horario,
            proibido: pix.proibido ? 1 : 0,
        };

        if (idx >= 0) {
            pendentes[idx] = registro;
        } else {
            pendentes.push(registro);
        }
        salvarPendentesDebounced();
    } catch (err) {
        log('️', `Falha ao persistir pagamento pendente: ${err.message}`);
    }
}

async function restaurarPagamentosPendentes(state) {
    try {
        const cutoff = Date.now() - 15 * 60 * 1000;
        let restaurados = 0;

        for (const row of pendentes) {
            if (row.horario <= cutoff) continue;

            const jaExiste = state.pagamentosRecentes.find(p => p.id === row.id);
            if (!jaExiste) {
                const pix = {
                    id: row.id,
                    nomeCompleto: row.nome,
                    nomeNormalizado: row.nome_normalizado,
                    valor: row.valor,
                    banco: row.banco,
                    horario: row.horario,
                    proibido: row.proibido === 1,
                    filaUsada: null,
                };
                state.pagamentosRecentes.push(pix);
                state.indexarPagamento(pix);
                restaurados++;
            }
        }

        const antes = pendentes.length;
        pendentes = pendentes.filter(p => p.horario > cutoff);
        if (pendentes.length !== antes) salvarPendentesDebounced();

        if (restaurados > 0) {
            log('', `[RECOVERY] ${restaurados} pagamento(s) pendente(s) restaurado(s) do JSON.`);
        }
        return restaurados;
    } catch (err) {
        log('️', `Falha ao restaurar pagamentos pendentes: ${err.message}`);
        return 0;
    }
}

async function marcarPendenteConcluido(pixId) {
    try {
        const antes = pendentes.length;
        pendentes = pendentes.filter(p => p.id !== pixId);
        if (pendentes.length !== antes) salvarPendentesDebounced();
    } catch (_) { }
}

function fechar() {
    if (_faturamentoTimer) {
        clearTimeout(_faturamentoTimer);
        try { fs.writeFileSync(FATURAMENTO_PATH, JSON.stringify(pagamentos), 'utf-8'); } catch (_) { }
    }
    if (_pendentesTimer) {
        clearTimeout(_pendentesTimer);
        try { fs.writeFileSync(PENDENTES_PATH, JSON.stringify(pendentes), 'utf-8'); } catch (_) { }
    }
    return Promise.resolve();
}

module.exports = {
    inicializar,
    inserirPagamento,
    getStats,
    getHistorico,
    getVendasPorHora,
    salvarPendente,
    restaurarPagamentosPendentes,
    marcarPendenteConcluido,
    fechar,
};
