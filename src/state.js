
class BoundedSet {
    constructor(maxSize) {
        this._set = new Set();
        this._maxSize = maxSize;
    }
    add(val) {
        if (this._set.size >= this._maxSize) {
            const first = this._set.values().next().value;
            this._set.delete(first);
        }
        this._set.add(val);
    }
    has(val) { return this._set.has(val); }
    delete(val) { return this._set.delete(val); }
    clear() { this._set.clear(); }
    get size() { return this._set.size; }
    values() { return this._set.values(); }
    forEach(fn) { this._set.forEach(fn); }
    [Symbol.iterator]() { return this._set[Symbol.iterator](); }
}

class BoundedMap {
    constructor(maxSize) {
        this._map = new Map();
        this._maxSize = maxSize;
    }
    set(key, val) {
        if (this._map.size >= this._maxSize && !this._map.has(key)) {
            const first = this._map.keys().next().value;
            this._map.delete(first);
        }
        this._map.set(key, val);
    }
    get(key) { return this._map.get(key); }
    has(key) { return this._map.has(key); }
    delete(key) { return this._map.delete(key); }
    clear() { this._map.clear(); }
    get size() { return this._map.size; }
    entries() { return this._map.entries(); }
    keys() { return this._map.keys(); }
    values() { return this._map.values(); }
    forEach(fn) { this._map.forEach(fn); }
    [Symbol.iterator]() { return this._map[Symbol.iterator](); }
}

class BoundedArray {
    constructor(maxSize, ttlMs, timestampField = 'horario') {
        this._arr = [];
        this._maxSize = maxSize;
        this._ttlMs = ttlMs;
        this._tsField = timestampField;
    }

    push(item) {
        if (this._arr.length >= this._maxSize) this.purge();
        while (this._arr.length >= this._maxSize) this._arr.shift();
        this._arr.push(item);
    }

    purge() {
        const agora = Date.now();
        let writeIdx = 0;
        for (let i = 0; i < this._arr.length; i++) {
            const ts = this._arr[i][this._tsField];
            if (ts && (agora - ts) < this._ttlMs) {
                this._arr[writeIdx++] = this._arr[i];
            }
        }
        const removidos = this._arr.length - writeIdx;
        this._arr.length = writeIdx;
        return removidos;
    }

    get(index) { return this._arr[index]; }
    first() { return this._arr[0]; }
    filter(fn) { return this._arr.filter(fn); }
    find(fn) { return this._arr.find(fn); }
    findIndex(fn) { return this._arr.findIndex(fn); }
    shift() { return this._arr.shift(); }
    splice(start, count) { return this._arr.splice(start, count); }
    forEach(fn) { this._arr.forEach(fn); }
    map(fn) { return this._arr.map(fn); }
    some(fn) { return this._arr.some(fn); }

    removeWhere(predicado) {
        let writeIdx = 0;
        for (let i = 0; i < this._arr.length; i++) {
            if (!predicado(this._arr[i])) {
                this._arr[writeIdx++] = this._arr[i];
            }
        }
        const removidos = this._arr.length - writeIdx;
        this._arr.length = writeIdx;
        return removidos;
    }

    get length() { return this._arr.length; }
    set _internal(newArr) { this._arr = newArr; }
    [Symbol.iterator]() { return this._arr[Symbol.iterator](); }
}

// timer tracking
const _activeTimers = new Set();

function startTrackedTimeout(fn, ms) {
    const timerId = setTimeout(() => {
        _activeTimers.delete(timerId);
        try { fn(); } catch (_) { }
    }, ms);
    _activeTimers.add(timerId);
    return timerId;
}

function clearTrackedTimeout(timerId) {
    clearTimeout(timerId);
    _activeTimers.delete(timerId);
}

function getActiveTimerCount() {
    return _activeTimers.size;
}

// constantes
const TIMINGS = Object.freeze({
    LOCK_TIMEOUT_MS: 90_000,
    RETRY_INTERVAL_MS: 3000,
    RETRY_MAX_TENTATIVAS: 20,
    DELETE_DELAY_SHORT_MS: 8000,
    DELETE_DELAY_MEDIUM_MS: 12000,
    DELETE_DELAY_LONG_MS: 20000,
    DEDUP_TTL_MS: 5000,
    INSTRUCOES_DELAY_MS: 2000,
    IMAGEM_DELAY_MS: 1500,
    HUMAN_DELAY_MIN_MS: 300,
    HUMAN_DELAY_MAX_MS: 1200,
    HUMAN_TYPING_MIN_MS: 300,
    HUMAN_TYPING_MAX_MS: 800,
    RATE_LIMIT_MSGS: 4,
    RATE_LIMIT_WINDOW_MS: 15000,
    GC_INTERVAL_MS: 20_000,
    FILA_MAX_AGE_MS: 1 * 60 * 60 * 1000,
    FILA_DONE_MAX_AGE_MS: 15 * 60 * 1000,
    PGTO_USADO_MAX_AGE_MS: 3 * 60 * 1000,
    HEAP_CRITICO_MB: 150,
});

const REGRAS = Object.freeze({
    VALOR_FALLBACK: 0.85,
    NOME_MIN_LENGTH: 3,
    CONFIRMACOES_PARA_SALA: 2,
    TAXA_MEDIADOR_POR_FILA: 0.50,
    TOLERANCIA_TAXA_PIX: 0,
});

module.exports = {
    pagamentosRecentes: new BoundedArray(30, 8 * 60 * 1000, 'horario'),

    _indicePorNome: new Map(),

    indexarPagamento(pix) {
        const key = pix.nomeNormalizado;
        if (!this._indicePorNome.has(key)) this._indicePorNome.set(key, []);
        this._indicePorNome.get(key).push(pix);
    },

    buscarPagamentosPorNome(nomeNormalizado) {
        return this._indicePorNome.get(nomeNormalizado) || [];
    },

    limparIndicePagamentos() {
        this._indicePorNome.clear();
        for (const p of this.pagamentosRecentes) {
            const key = p.nomeNormalizado;
            if (!this._indicePorNome.has(key)) this._indicePorNome.set(key, []);
            this._indicePorNome.get(key).push(p);
        }
    },

    filasPagamento: new BoundedMap(15),
    threadsRespondidas: new BoundedSet(200),
    threadsAguardandoSala: new BoundedArray(10, 15 * 60 * 1000, 'criadoEm'),

    salasAguardandoGo: new BoundedMap(15),
    mensagensProcessadas: new BoundedSet(50),
    usuariosProcessando: new BoundedSet(15),

    _rateLimitMap: new BoundedMap(15),
    threadsWinPendente: new BoundedSet(10),
    tentativasFalhas: new BoundedMap(20),

    salasAtivasPorCanal: new BoundedMap(50),
    _criacaoSalaLocks: new BoundedSet(30),
    cooldownBotaoSala: new BoundedMap(50),
    salasIDsProcessados: new BoundedSet(50),

    heartbeat: { tentativaReconexaoTelegram: 0 },
    statusConexoes: { discord: false, telegram: false },
    licencaInfo: { vencimento: null, key: null, status: null },
    botRodando: true,

    io: null,
    telegram: null,
    discordClient: null,
    _tgWatchdogId: null,

    TIMINGS,
    REGRAS,

    startTrackedTimeout,
    clearTrackedTimeout,
    getActiveTimerCount,

    BoundedSet,
    BoundedMap,
    BoundedArray,
};