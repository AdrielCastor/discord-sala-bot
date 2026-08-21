const axios = require('axios');
const os = require('os');
const crypto = require('crypto');
const config = require('../config');
const { log } = require('../logger');
const state = require('../state');

const PAINEL_URL = process.env.PAINEL_URL || 'https://salvesalasadmin.squareweb.app';
const REVERIFICACAO_INTERVALO_MS = 30 * 60 * 1000;

const HWID = crypto.createHash('sha256')
    .update(os.hostname() + os.platform() + os.arch() + os.cpus()[0].model)
    .digest('hex')
    .substring(0, 32);

function mascararKey(key) {
    if (!key || key.length < 8) return '****';
    return key.substring(0, 5) + '****' + key.substring(key.length - 4);
}

async function reverificarLicenca() {
    const url = `${PAINEL_URL}/verificar`;

    try {
        const resposta = await axios.post(
            url,
            { key: config.licenca, hwid: HWID },
            {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
            }
        );

        if (resposta.data.status === 'ATIVA') {
            state.licencaInfo = {
                vencimento: resposta.data.vencimento || null,
                key: mascararKey(config.licenca),
                status: 'ATIVA',
            };
            log('', `Re-verificação OK — Vencimento: ${resposta.data.vencimento}`);
        } else {
            log('', `LICENÇA REVOGADA: ${resposta.data.mensagem || 'Key não mais válida'}`);
            console.log(`\n BOT DESLIGADO — Licença expirada/revogada: ${resposta.data.mensagem}`);
            state.licencaInfo = {
                vencimento: null,
                key: mascararKey(config.licenca),
                status: 'NEGADA',
            };
            process.exit(1);
        }
    } catch (err) {
        const errMsg = err.code || err.message || String(err);
        log('️', `Re-verificação falhou (rede): ${errMsg} — próximo check em 30min`);
    }
}

async function verificarLicenca(tentativas = 5, delayMs = 10000) {
    const url = `${PAINEL_URL}/verificar`;
    console.log(` Autenticando com o Painel da Salve Salas...`);
    console.log(` URL: ${url}`);

    for (let i = 0; i < tentativas; i++) {
        try {
            const resposta = await axios.post(
                url,
                { key: config.licenca, hwid: HWID },
                {
                    timeout: 30000,
                    headers: { 'Content-Type': 'application/json' },
                }
            );

            if (resposta.data.status === 'ATIVA') {
                console.log(` Licença verificada com sucesso! Vencimento: ${resposta.data.vencimento}\n`);

                state.licencaInfo = {
                    vencimento: resposta.data.vencimento || null,
                    key: mascararKey(config.licenca),
                    status: 'ATIVA',
                };

                setInterval(() => {
                    reverificarLicenca().catch(() => {});
                }, REVERIFICACAO_INTERVALO_MS);
                log('', `Re-verificação automática agendada a cada ${REVERIFICACAO_INTERVALO_MS / 60000} minutos`);

                return true;
            } else {
                console.log(`\n ACESSO NEGADO: ${resposta.data.mensagem}`);
                state.licencaInfo = {
                    vencimento: null,
                    key: mascararKey(config.licenca),
                    status: 'NEGADA',
                };
                process.exit(1);
            }
        } catch (err) {
            const errMsg = err.code || err.message || String(err);
            console.log(`️ Erro ao conectar ao painel: ${errMsg} (tentativa ${i + 1}/${tentativas})`);

            if (i < tentativas - 1) {
                const espera = delayMs * (i + 1);
                console.log(`    Tentando novamente em ${espera / 1000}s...`);
                await new Promise(r => setTimeout(r, espera));
            } else {
                console.log('\n ERRO DE CONEXÃO: O Painel da Salve Salas não respondeu após todas as tentativas.');
                console.log(`   URL tentada: ${url}`);
                console.log(`   Último erro: ${errMsg}`);
                process.exit(1);
            }
        }
    }
}

module.exports = { verificarLicenca, HWID };
