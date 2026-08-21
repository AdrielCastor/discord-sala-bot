const state = require('./state');

const MAX_LOG_BUFFER = 80;
const INITIAL_LOGS_TO_SEND = 30;
const logBuffer = [];

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'INFO'];

const EMOJI_TO_LEVEL = {
    '': 'DEBUG', '': 'DEBUG', '': 'DEBUG',
    '🟢': 'INFO', '': 'INFO', '': 'INFO', '️': 'INFO',
    '': 'INFO', '': 'INFO', '': 'INFO', '': 'INFO',
    '': 'INFO', '️': 'INFO', '': 'INFO', '': 'INFO',
    '': 'INFO', '': 'INFO', '️': 'INFO', '️': 'INFO',
    '': 'INFO', '🟡': 'INFO',
    '️': 'WARN', '': 'WARN', '': 'WARN',
    '': 'ERROR', '': 'ERROR',
};

function log(emoji, msg, ...args) {
    const level = EMOJI_TO_LEVEL[emoji] || 'INFO';

    if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    console.log(`[${ts}] [${level}] ${emoji} ${msg}`, ...args);

    const entry = {
        timestamp: Date.now(),
        level,
        texto: `${emoji} ${msg}` + (args.length ? ' ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') : ''),
        tipo: level === 'ERROR' || level === 'WARN' ? 'error' : 'info',
    };

    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();

    if (state.io) state.io.emit('log', entry);
}

function getRecentLogs() {
    return logBuffer.slice(-INITIAL_LOGS_TO_SEND);
}

module.exports = { log, getRecentLogs };
