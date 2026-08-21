const fs = require('fs');
const path = require('path');
const { log } = require('../logger');

const CONFIG_PATH = path.join(process.cwd(), 'thread_message.json');

let config = {
    mensagem: '',
    incluirPix: false,
    pixChave: '',
};

let _saveTimer = null;

function salvarDebounced() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
            log('', '[THREAD-MSG] Config salva.');
        } catch (err) {
            log('', `[THREAD-MSG] Erro ao salvar: ${err.message}`);
        }
        _saveTimer = null;
    }, 300);
}

function carregar() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            const parsed = JSON.parse(raw || '{}');
            config.mensagem = parsed.mensagem || '';
            config.incluirPix = Boolean(parsed.incluirPix);
            config.pixChave = parsed.pixChave || '';
        }
        log('️', `[THREAD-MSG] Config carregada.`);
    } catch (err) {
        log('️', `[THREAD-MSG] Erro ao carregar: ${err.message}`);
    }
}

function getConfig() {
    return { ...config };
}

function setConfig(novaConfig) {
    config.mensagem = String(novaConfig.mensagem || '').substring(0, 4000);
    config.incluirPix = Boolean(novaConfig.incluirPix);
    if (novaConfig.pixChave !== undefined) {
        config.pixChave = String(novaConfig.pixChave).substring(0, 100);
    }
    salvarDebounced();
}

function getMensagemCustom() {
    return config.mensagem || null;
}

function deveIncluirPix() {
    return config.incluirPix;
}

function getPixChave() {
    return config.pixChave;
}

carregar();

module.exports = { getConfig, setConfig, getMensagemCustom, deveIncluirPix, getPixChave, carregar };
