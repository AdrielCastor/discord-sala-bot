const { google } = require('googleapis');
const axios = require('axios');
const config = require('../config');
const { log } = require('../logger');
const { normalizarNome, sanitizar, detectarBanco, criarRegistroPix } = require('../utils');
const state = require('../state');

const POLL_INTERVAL_MS = 60_000;
const MAX_ERROS_CONSECUTIVOS = 5;
const MAX_TEXTO_EMAIL = 5000;
const OCR_SPACE_URL = 'https://api.ocr.space/parse/image';

let oauth2Client = null;
let gmail = null;
let intervalId = null;
let errosConsecutivos = 0;

async function enviarAlertaAdmin(discordClient, mensagem) {
    try {
        if (config.discord?.logChannelId && config.discord.logChannelId !== 'COLE_O_ID_DO_CANAL_AQUI') {
            const canalLog = await discordClient.channels.fetch(config.discord.logChannelId);
            await canalLog.send(mensagem);
        }
    } catch (_) { log('️', 'Falha ao enviar alerta no canal de logs.'); }
}

function criarClienteOAuth2() {
    oauth2Client = new google.auth.OAuth2(
        config.gmail.clientId,
        config.gmail.clientSecret,
        'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({ refresh_token: config.gmail.refreshToken });
    gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    log('', 'Gmail OAuth2 configurado com sucesso.');
}

function htmlParaTexto(html) {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(p|div|tr|li|h[1-6]|section|article|header|footer|blockquote)\b[^>]*>/gi, '\n')
        .replace(/<\/td>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([a-fA-F0-9]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&aacute;/gi, 'á').replace(/&Aacute;/g, 'Á')
        .replace(/&eacute;/gi, 'é').replace(/&Eacute;/g, 'É')
        .replace(/&iacute;/gi, 'í').replace(/&Iacute;/g, 'Í')
        .replace(/&oacute;/gi, 'ó').replace(/&Oacute;/g, 'Ó')
        .replace(/&uacute;/gi, 'ú').replace(/&Uacute;/g, 'Ú')
        .replace(/&agrave;/gi, 'à').replace(/&Agrave;/g, 'À')
        .replace(/&atilde;/gi, 'ã').replace(/&Atilde;/g, 'Ã')
        .replace(/&otilde;/gi, 'õ').replace(/&Otilde;/g, 'Õ')
        .replace(/&acirc;/gi, 'â').replace(/&Acirc;/g, 'Â')
        .replace(/&ecirc;/gi, 'ê').replace(/&Ecirc;/g, 'Ê')
        .replace(/&ocirc;/gi, 'ô').replace(/&Ocirc;/g, 'Ô')
        .replace(/&ccedil;/gi, 'ç').replace(/&Ccedil;/g, 'Ç')
        .replace(/&uuml;/gi, 'ü').replace(/&ntilde;/gi, 'ñ')
        .replace(/&[a-zA-Z]+;/gi, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extrairTextoDoPayload(payload) {
    const partesPlano = [];
    const partesHtml = [];

    function percorrer(parte) {
        if (parte.body?.data) {
            const decoded = Buffer.from(parte.body.data, 'base64url').toString('utf-8');
            if (parte.mimeType === 'text/plain') partesPlano.push(decoded);
            else if (parte.mimeType === 'text/html') partesHtml.push(decoded);
        }
        if (parte.parts) parte.parts.forEach(percorrer);
    }

    percorrer(payload);
    if (partesPlano.length > 0) return partesPlano.join(' ');
    return htmlParaTexto(partesHtml.join(' '));
}

function extrairTextoHtmlDoPayload(payload) {
    const partesHtml = [];
    function percorrer(parte) {
        if (parte.body?.data && parte.mimeType === 'text/html') {
            partesHtml.push(Buffer.from(parte.body.data, 'base64url').toString('utf-8'));
        }
        if (parte.parts) parte.parts.forEach(percorrer);
    }
    percorrer(payload);
    return partesHtml.length > 0 ? htmlParaTexto(partesHtml.join(' ')) : null;
}

function extrairAnexosDeImagem(payload) {
    const anexos = [];

    function percorrer(parte) {
        if (parte.body?.attachmentId && parte.mimeType && parte.mimeType.startsWith('image/')) {
            anexos.push({
                mimeType: parte.mimeType,
                attachmentId: parte.body.attachmentId,
                filename: parte.filename || 'comprovante',
            });
        }
        if (parte.parts) parte.parts.forEach(percorrer);
    }

    percorrer(payload);
    return anexos;
}

async function chamarOcrSpace(base64Data, mimeType, engine = 2) {
    const apiKey = process.env.OCR_API_KEY;
    if (!apiKey) {
        log('️', '[OCR.space] OCR_API_KEY não definida no .env');
        return null;
    }

    try {
        const dataPrefix = `data:${mimeType || 'image/png'};base64,${base64Data}`;

        const response = await axios.post(OCR_SPACE_URL,
            new URLSearchParams({
                base64Image: dataPrefix,
                language: 'por',
                isOverlayRequired: 'false',
                detectOrientation: 'true',
                scale: 'true',
                isTable: 'true',
                OCREngine: String(engine),
            }).toString(),
            {
                headers: {
                    'apikey': apiKey,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: 25000,
            }
        );

        const result = response.data;
        if (result.IsErroredOnProcessing) {
            log('️', `[OCR.space E${engine}] Erro: ${result.ErrorMessage || 'desconhecido'}`);
            return null;
        }

        const textoOcr = (result.ParsedResults || []).map(r => r.ParsedText || '').join('\n');
        if (!textoOcr || textoOcr.trim().length < 10) return null;

        return textoOcr;
    } catch (err) {
        log('️', `[OCR.space E${engine}] Falhou: ${err.message}`);
        return null;
    }
}

async function extrairDadosDeImagem(base64Data, mimeType) {
    for (const engine of [2, 1]) {
        const texto = await chamarOcrSpace(base64Data, mimeType, engine);
        if (!texto) continue;

        log('', `[OCR.space E${engine}] ──── TEXTO COMPLETO ────`);
        const linhasLog = texto.split('\n');
        for (let i = 0; i < linhasLog.length; i++) {
            if (linhasLog[i].trim()) {
                log('', `[OCR L${i + 1}] ${linhasLog[i].trim()}`);
            }
        }
        log('', `[OCR.space E${engine}] ──── FIM DO TEXTO ────`);

        const valor = extrairValorDoTexto(texto);
        const nome = extrairNomePIX(texto);

        if (nome) {
            log('', `[OCR.space E${engine}]  EXTRAÍDO: Nome="${nome}" | Valor=R$${valor || '?'}`);
            return { nome, valor: valor || null };
        }
        log('️', `[OCR.space E${engine}] Texto lido, mas nome não identificado.`);
    }

    log('', '[OCR] Não foi possível extrair nome do comprovante.');
    return { nome: null, valor: null };
}

const RE_VALOR = [
    /R\$\s*([\d.]+,\d{2})/i,
    /R\$\s*([\d]+[.,]\d{2})/i,
    /valor[:\s]*R?\$?\s*([\d.]+,\d{2})/i,
    /valor\s+(?:pago|recebido|transferido)[:\s]*R?\$?\s*([\d.]+,\d{2})/i,
    /([\d.]+,\d{2})\s*BRL/i,
    /Pix\s+de\s+([\d.]+,\d{2})\s*BRL/i,
];

function extrairValorDoTexto(texto) {
    for (const regex of RE_VALOR) {
        const match = texto.match(regex);
        if (match) {
            return parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
        }
    }
    return null;
}

const extrairValorDoEmail = extrairValorDoTexto;

const REGEX_NOME_EMAIL = [
    /(?:Pix de)\s+[\d.,]+\s*BRL\s+de\s+(.*?)(?:\.|$|\n)/i,
    /(?:recebeu um Pix de)\s+[\d.,]+\s*BRL\s+de\s+(.*?)(?:\.|$|\n)/i,
    /[\d.,]+\s*BRL\s+de\s+([A-ZÀ-Úa-zà-ú][A-ZÀ-Úa-zà-ú\s]+?)(?:\.|$|\n)/i,
    /(?:Voc[eê] recebeu um Pix de)\s+(.*?)(?:\.|Confira|e o valor|$)/i,
    /(?:Voc[eê] recebeu uma transfer[eê]ncia de)\s+(.*?)(?:\.|Confira|e o valor|$)/i,
    /(?:transfer[eê]ncia de)\s+R\$\s*[\d.,]+\s+de\s+(.*?)(?:\.|$)/i,
    /(?:Pix de)\s+R\$\s*[\d.,]+\s+de\s+(.*?)(?:\.|$)/i,
    /(?:recebeu.*?Pix.*?de)\s+(.*?)(?:\.|no valor|$)/i,
    /(?:transfer[eê]ncia.*?recebida.*?de)\s+(.*?)(?:\.|no valor|$)/i,
    /R\$\s*[\d.,]+\s+de\s+(.*?)(?:\.|$|\n)/i,
    /(?:recebeu.*?de)\s+(.*?)(?:\.|$|\n)/i,
    /(?:pagador|remetente|origem)[:\s]+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)+)/,
    /(?:enviou|mandou|transferiu).*?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)+)/,
];

function extrairNomeDoEmail(texto) {
    const textoNorm = texto.replace(/\r?\n/g, ' ').replace(/ {2,}/g, ' ');

    for (const regex of REGEX_NOME_EMAIL) {
        const match = textoNorm.match(regex);
        if (match) {
            let nome = match[1]
                .trim()
                .replace(/e o valor.*/gi, '')
                .replace(/no valor.*/gi, '')
                .replace(/\.$/, '')
                .replace(/^[\d.,]+\s*(?:BRL)?\s*(?:de\s+)?/i, '')
                .trim();
            if (nome.length >= 3 && nome.length <= 80) {
                log('', `[GMAIL NOME] Regex match: "${nome}" (via ${regex.source.substring(0, 40)}...)`);
                return nome;
            }
        }
    }
    return null;
}

const PALAVRAS_BLOQUEADAS = new Set([
    'pix', 'comprovante', 'transferencia', 'transferência', 'pagamento',
    'pagamentos', 'valor', 'data', 'hora', 'horario', 'horário', 'tipo',
    'banco', 'agencia', 'agência', 'conta', 'instituicao', 'instituição',
    'identificador', 'transacao', 'transação', 'chave', 'email',
    'celular', 'telefone', 'cpf', 'cnpj', 'destino', 'favorecido',
    'recebedor', 'enviado', 'realizado', 'confirmado', 'concluido',
    'concluído', 'sucesso', 'aprovado', 'compartilhar', 'salvar',
    'fechar', 'voltar', 'ok', 'pdf', 'quem', 'pagou', 'recebeu',
    'para', 'nome', 'completo', 'código', 'codigo', 'autenticação',
    'autenticacao', 'descrição', 'descricao', 'mensagem',
    'ip', 'sa', 's.a', 's.a.', 'ltda', 'eireli', 'me',
    'estamos', 'aqui', 'ajudar', 'ouvidoria', 'atendimento',
    'id', 'da', 'dúvida', 'duvida',
    'nubank', 'nu', 'itau', 'itaú', 'bradesco', 'caixa', 'santander',
    'inter', 'c6', 'picpay', 'mercado', 'original', 'neon', 'next',
    'sicoob', 'sicredi', 'banrisul', 'safra', 'btg', 'pagseguro',
    'nupagamentos', 'stone', 'cielo', 'rede', 'getnet',
]);

const FRASES_BLOQUEADAS = [
    'comprovante de', 'transferencia pix', 'transferência pix',
    'pix enviado', 'pix recebido', 'pix realizado',
    'operacao realizada', 'operação realizada', 'transacao efetuada',
    'dados do pagador', 'dados do recebedor', 'dados de quem',
    'quem pagou', 'quem recebeu', 'quem enviou',
    'banco central', 'sistema financeiro', 'dados da transação',
    'dados da transacao',
    'nu pagamentos', 'nu pagamento', 'nupagamentos',
    'mercado pago', 'mercadopago', 'pagseguro', 'pag seguro',
    'picpay', 'pic pay', 'stone pagamentos', 'cielo',
    'banco inter', 'banco original', 'banco do brasil',
    'instituição de', 'instituição de pagamento',
    'instituicao de', 'instituicao de pagamento',
    'estamos aqui', 'ajudar se',
];

function titleCase(nome) {
    if (!nome) return nome;
    const conectores = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'del']);
    if (nome === nome.toUpperCase() && nome.length > 3) {
        return nome.toLowerCase().split(' ').map(w =>
            conectores.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)
        ).join(' ');
    }
    return nome;
}

function limparCandidatoNome(raw) {
    if (!raw) return null;

    let nome = raw
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s*CPF[\s.:*•].*/i, '')
        .replace(/\s*CNPJ[\s.:*•].*/i, '')
        .replace(/\s*Valor.*/i, '')
        .replace(/\s*R\$.*/i, '')
        .replace(/\s*Institui[çc][aã]o.*/i, '')
        .replace(/\s*Banco.*/i, '')
        .replace(/\s*Ag[eê]ncia.*/i, '')
        .replace(/\s*Conta.*/i, '')
        .replace(/\s*Chave.*/i, '')
        .replace(/\s*Tipo\s.*/i, '')
        .replace(/\s*Data\s.*/i, '')
        .replace(/\s*Hora\s.*/i, '')
        .replace(/\s*C[oó]digo.*/i, '')
        .replace(/\s*Identifica.*/i, '')
        .replace(/[.:;,\-_*•]+$/, '')
        .replace(/[\s*•]+\d{3}[\d.\-/]+$/, '')
        .trim();

    nome = titleCase(nome);

    if (!nome || nome.length < 5 || nome.length > 80) return null;

    const palavras = nome.split(' ').filter(w => w.length > 0);
    if (palavras.length < 2) return null;

    const primeiraLower = palavras[0].toLowerCase();
    if (PALAVRAS_BLOQUEADAS.has(primeiraLower)) return null;

    const nomeLower = nome.toLowerCase();
    for (const palavra of palavras) {
        const pLower = palavra.toLowerCase();
        if (['pagamentos', 'pagamento', 'nupagamentos', 'instituição',
            'instituicao', 'financeiro', 'ouvidoria', 'atendimento',
            'ltda', 'eireli', 'cnpj'].includes(pLower)) {
            return null;
        }
    }

    for (const frase of FRASES_BLOQUEADAS) {
        if (nomeLower.startsWith(frase) || nomeLower.includes(frase)) return null;
    }

    const palavrasReais = palavras.filter(w =>
        w.length >= 2 && /^[A-ZÀ-Úa-zà-ú]/.test(w)
    );
    if (palavrasReais.length < 2) return null;

    if (/^\d[\d.\-/\s]+$/.test(nome)) return null;

    if (/\d{2}\.\d{3}\.\d{3}/.test(nome)) return null;

    return nome;
}

function extrairNomePIX(texto) {
    if (!texto) return null;

    const textoLimpo = texto
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\t/g, ' ')
        .replace(/ {2,}/g, ' ');

    const linhas = textoLimpo.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    log('', `[OCR NOME] Analisando ${linhas.length} linhas do comprovante...`);

    const LABELS_ORIGEM = [
        /origem/i, /quem\s+pagou/i, /quem\s+enviou/i, /quem\s+transferiu/i,
        /remetente/i, /pagador/i, /dados\s+de\s+quem\s+pagou/i,
        /dados\s+do\s+pagador/i,
    ];

    for (let i = 0; i < linhas.length; i++) {
        const linhaAtual = linhas[i];
        const ehOrigemLabel = LABELS_ORIGEM.some(r => r.test(linhaAtual));

        if (ehOrigemLabel) {
            log('', `[OCR NOME] Seção ORIGEM encontrada na linha ${i + 1}: "${linhaAtual}"`);

            for (let j = i + 1; j < Math.min(i + 6, linhas.length); j++) {
                const linhaJ = linhas[j];

                if (/^(destino|id da transação|id da transacao|valor|chave|data|hora|estamos)/i.test(linhaJ)) {
                    break;
                }

                const matchNome = linhaJ.match(/^nome\s*[:\-]?\s*(.+)/i);
                if (matchNome) {
                    const nome = limparCandidatoNome(matchNome[1]);
                    if (nome) {
                        log('', `[OCR NOME] Estratégia 0 (Seção Origem → Nome): "${nome}"`);
                        return nome;
                    }
                }

                if (!/^(cpf|cnpj|chave|instituição|instituicao|valor|tipo|conta|ag[eê]ncia|\d{3}[.\-])/i.test(linhaJ)) {
                    const nome = limparCandidatoNome(linhaJ);
                    if (nome) {
                        log('', `[OCR NOME] Estratégia 0 (Seção Origem → linha direta): "${nome}"`);
                        return nome;
                    }
                }
            }
        }
    }

    const REGEX_MESMA_LINHA = [
        /^nome\s*(?:completo)?\s*[:\-]?\s+(.+)/i,
        /^pagador\s*[:\-]?\s+(.+)/i,
        /^remetente\s*[:\-]?\s+(.+)/i,
        /^origem\s*[:\-]?\s+(.+)/i,
        /^enviado\s+por\s*[:\-]?\s+(.+)/i,
        /^titular\s*[:\-]?\s+(.+)/i,
        /^cliente\s*[:\-]?\s+(.+)/i,
        /^destinat[aá]rio\s*[:\-]?\s+(.+)/i,
        /^favorecido\s*[:\-]?\s+(.+)/i,
        /^recebedor\s*[:\-]?\s+(.+)/i,
        /^de\s*:\s*(.+)/i,
        /^para\s*:\s*(.+)/i,
    ];

    for (const linha of linhas) {
        for (const regex of REGEX_MESMA_LINHA) {
            const match = linha.match(regex);
            if (match) {
                const nome = limparCandidatoNome(match[1]);
                if (nome) {
                    log('', `[OCR NOME] Estratégia 1 (label mesma linha): "${nome}"`);
                    return nome;
                }
            }
        }
    }

    const LABELS_PROXIMA = [
        /^quem\s+pagou\s*[:\-]?\s*$/i,
        /^quem\s+enviou\s*[:\-]?\s*$/i,
        /^quem\s+transferiu\s*[:\-]?\s*$/i,
        /^pagador\s*[:\-]?\s*$/i,
        /^nome\s*(?:completo)?\s*[:\-]?\s*$/i,
        /^remetente\s*[:\-]?\s*$/i,
        /^origem\s*[:\-]?\s*$/i,
        /^de\s*[:\-]\s*$/i,
        /^de\s*[:\-]?\s*$/i,
        /^titular\s*[:\-]?\s*$/i,
        /^enviado\s+por\s*[:\-]?\s*$/i,
        /^dados\s+(?:de\s+)?quem\s+pagou\s*[:\-]?\s*$/i,
        /^dados\s+do\s+pagador\s*[:\-]?\s*$/i,
        /^quem\s+recebeu\s*[:\-]?\s*$/i,
        /^destinat[aá]rio\s*[:\-]?\s*$/i,
        /^favorecido\s*[:\-]?\s*$/i,
        /^recebedor\s*[:\-]?\s*$/i,
        /^para\s*[:\-]?\s*$/i,
        /^dados\s+(?:de\s+)?quem\s+recebeu\s*[:\-]?\s*$/i,
        /^detalhes\s+do\s+pix\s*$/i,
    ];

    for (let i = 0; i < linhas.length - 1; i++) {
        const linhaAtual = linhas[i];

        for (const regex of LABELS_PROXIMA) {
            if (regex.test(linhaAtual)) {
                const prox = linhas[i + 1];

                if (/^(cpf|cnpj|chave|valor|data|hora|tipo|banco|ag[eê]ncia|institui|conta|\d{3}[.\-])/i.test(prox)) {
                    continue;
                }

                const nome = limparCandidatoNome(prox);
                if (nome) {
                    log('', `[OCR NOME] Estratégia 2 (label → próxima linha "${linhaAtual}"): "${nome}"`);
                    return nome;
                }

                if (i + 2 < linhas.length && !/^(cpf|cnpj|chave|valor)/i.test(linhas[i + 2])) {
                    const nome2 = limparCandidatoNome(prox + ' ' + linhas[i + 2]);
                    if (nome2) {
                        log('', `[OCR NOME] Estratégia 2 (label → 2 linhas): "${nome2}"`);
                        return nome2;
                    }
                }
            }
        }
    }

    for (const linha of linhas) {
        const trimmed = linha.trim();

        if (/^[A-ZÀ-Ú]{2,}(?:\s+(?:[A-ZÀ-Ú]{2,}|DE|DA|DO|DAS|DOS|E|DEL)){1,8}$/.test(trimmed)) {
            const nome = limparCandidatoNome(trimmed);
            if (nome) {
                const lower = trimmed.toLowerCase();
                const ehTitulo = FRASES_BLOQUEADAS.some(f => lower.includes(f)) ||
                    lower.includes('comprovante') || lower.includes('transferencia') ||
                    lower.includes('transferência') || lower.includes('pagamento pix') ||
                    lower.includes('pix enviado') || lower.includes('pix recebido') ||
                    lower.includes('operacao') || lower.includes('operação');

                if (!ehTitulo) {
                    log('', `[OCR NOME] Estratégia 3 (linha MAIÚSCULA): "${nome}"`);
                    return nome;
                }
            }
        }
    }

    for (const linha of linhas) {
        const trimmed = linha.trim();

        if (/^[A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:[A-ZÀ-Ú][a-zà-ú]+|de|da|do|das|dos|e|del)){1,8}$/.test(trimmed)) {
            const nome = limparCandidatoNome(trimmed);
            if (nome) {
                log('', `[OCR NOME] Estratégia 4 (linha Title Case): "${nome}"`);
                return nome;
            }
        }
    }

    const RE_CAPS_SUBSTR = /([A-ZÀ-Ú]{2,}(?:\s+(?:[A-ZÀ-Ú]{2,}|DE|DA|DO|DAS|DOS|E|DEL)){1,8})/g;
    const candidatos = [];
    let matchFb;

    while ((matchFb = RE_CAPS_SUBSTR.exec(textoLimpo)) !== null) {
        const nome = limparCandidatoNome(matchFb[1]);
        if (nome) {
            const palavras = nome.split(' ');
            if (palavras.length >= 2 && palavras.length <= 6 && nome.length >= 5 && nome.length <= 50) {
                candidatos.push(nome);
            }
        }
    }

    if (candidatos.length > 0) {
        log('', `[OCR NOME] Estratégia 5 (substring CAPS): "${candidatos[0]}" (de ${candidatos.length} candidatos)`);
        return candidatos[0];
    }

    const nomeEmail = extrairNomeDoEmail(textoLimpo);
    if (nomeEmail) {
        log('', `[OCR NOME] Estratégia 6 (regex de e-mail): "${nomeEmail}"`);
        return nomeEmail;
    }

    log('', `[OCR NOME] Nenhuma estratégia encontrou nome nas ${linhas.length} linhas.`);
    return null;
}

const PIX_KEYWORDS = ['pix', 'transferência', 'transferencia', 'recebeu', 'nubank', 'pagamento', 'comprovante', 'wise', 'brl'];

async function buscarEmailsNaoLidos() {
    try {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread',
            maxResults: 10,
        });

        const mensagens = res.data.messages || [];
        if (mensagens.length === 0) { errosConsecutivos = 0; return; }

        log('', `[GMAIL] ${mensagens.length} e-mail(s) não lido(s).`);

        for (const msgRef of mensagens) {
            try {
                const msgCompleta = await gmail.users.messages.get({
                    userId: 'me',
                    id: msgRef.id,
                    format: 'full',
                });

                const payload = msgCompleta.data.payload;
                const headers = payload.headers || [];
                const assunto = (headers.find(h => h.name.toLowerCase() === 'subject') || {}).value || '';
                const assuntoLower = assunto.toLowerCase();

                if (!PIX_KEYWORDS.some(kw => assuntoLower.includes(kw))) {
                    await marcarComoLido(msgRef.id);
                    continue;
                }

                log('', `[GMAIL] Processando: "${assunto}"`);

                const textoEmail = sanitizar(extrairTextoDoPayload(payload), MAX_TEXTO_EMAIL);
                const textoCompleto = assunto + ' ' + textoEmail;

                log('', `[GMAIL] Corpo (300 chars): ${textoEmail.substring(0, 300).replace(/\n/g, ' | ')}`);

                let valor = extrairValorDoEmail(textoCompleto);
                let nomeCompleto = extrairNomeDoEmail(textoCompleto);

                const textoHtml = extrairTextoHtmlDoPayload(payload);
                if (textoHtml) {
                    const textoHtmlSan = sanitizar(textoHtml, MAX_TEXTO_EMAIL);
                    const textoCompletoHtml = assunto + ' ' + textoHtmlSan;
                    const nomeHtml = extrairNomeDoEmail(textoCompletoHtml);
                    const valorHtml = extrairValorDoEmail(textoCompletoHtml);

                    if (nomeHtml && (!nomeCompleto || nomeHtml.split(' ').length > nomeCompleto.split(' ').length)) {
                        log('', `[GMAIL] HTML nome mais completo: "${nomeHtml}" > "${nomeCompleto || 'nenhum'}"`);
                        nomeCompleto = nomeHtml;
                    }
                    if (!valor && valorHtml) valor = valorHtml;
                }

                if ((!valor || !nomeCompleto) && extrairAnexosDeImagem(payload).length > 0) {
                    const anexos = extrairAnexosDeImagem(payload);
                    log('️', `[OCR] E-mail tem ${anexos.length} imagem(ns). Tentando OCR...`);

                    for (const anexo of anexos) {
                        try {
                            const attachRes = await gmail.users.messages.attachments.get({
                                userId: 'me',
                                messageId: msgRef.id,
                                id: anexo.attachmentId,
                            });

                            const base64Data = attachRes.data.data;
                            if (!base64Data) continue;

                            const { nome: nomeOcr, valor: valorOcr } = await extrairDadosDeImagem(base64Data, anexo.mimeType);

                            if (!valor && valorOcr) valor = valorOcr;
                            if (!nomeCompleto && nomeOcr) nomeCompleto = nomeOcr;

                            if (valor && nomeCompleto) {
                                log('', `[OCR] Dados extraídos do comprovante: ${nomeCompleto} | R$${valor.toFixed(2)}`);
                                break;
                            }
                        } catch (errOcr) {
                            log('️', `[OCR] Erro no anexo "${anexo.filename}": ${errOcr.message}`);
                        }
                    }
                }

                if (!valor || valor <= 0) {
                    log('️', `[GMAIL] E-mail "${assunto}" — valor não encontrado.`);
                    await marcarComoLido(msgRef.id);
                    continue;
                }

                if (!nomeCompleto || nomeCompleto.length < 3) {
                    log('️', `[GMAIL] E-mail "${assunto}" — R$${valor.toFixed(2)}, nome não encontrado.`);
                    await marcarComoLido(msgRef.id);
                    continue;
                }

                const { banco, proibido } = detectarBanco(textoCompleto);

                const pixRecebido = criarRegistroPix(nomeCompleto, valor, banco, proibido);
                state.pagamentosRecentes.push(pixRecebido);
                state.indexarPagamento(pixRecebido);

                if (proibido) {
                    log('', `[GMAIL] PIX BARRADO! ${nomeCompleto} | ${banco}`);
                } else {
                    log('', `[GMAIL] Pix Salvo! ${nomeCompleto} | R$${valor.toFixed(2)} | ${banco}`);
                }

                await marcarComoLido(msgRef.id);

            } catch (errMsg) {
                log('', `[GMAIL] Erro ao processar e-mail ${msgRef.id}: ${errMsg.message}`);
            }
        }

        errosConsecutivos = 0;

    } catch (err) {
        errosConsecutivos++;
        log('', `[GMAIL] Erro no polling (${errosConsecutivos}/${MAX_ERROS_CONSECUTIVOS}): ${err.message}`);

        if (errosConsecutivos >= MAX_ERROS_CONSECUTIVOS) {
            log('', `[GMAIL] ${MAX_ERROS_CONSECUTIVOS} erros! Reiniciando em 30s...`);
            pararGmailMonitor();
            state.startTrackedTimeout(() => iniciarGmailMonitor(), 30_000);
        }
    }
}

async function marcarComoLido(messageId) {
    try {
        await gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: { removeLabelIds: ['UNREAD'] },
        });
    } catch (err) {
        log('️', `[GMAIL] Falha ao marcar como lido ${messageId}: ${err.message}`);
    }
}

function iniciarGmailMonitor() {
    if (intervalId) {
        log('️', '[GMAIL] Monitor já ativo.');
        return;
    }

    if (!config.gmail.clientId || !config.gmail.clientSecret || !config.gmail.refreshToken) {
        log('️', '[GMAIL] Credenciais não configuradas. Monitor NÃO iniciado.');
        log('', '[GMAIL] Use o Webhook do Discord como alternativa.');
        return;
    }

    criarClienteOAuth2();
    buscarEmailsNaoLidos();
    intervalId = setInterval(buscarEmailsNaoLidos, POLL_INTERVAL_MS);
    state.statusConexoes.email = true;
    if (state.io) state.io.emit('status', state.statusConexoes);
    const hasOcr = !!process.env.OCR_API_KEY;
    const ocrStatus = hasOcr ? ' OCR: OCR.space' : '️ OCR desativado';
    log('', `[GMAIL] Monitor iniciado! Polling: ${POLL_INTERVAL_MS / 1000}s. ${ocrStatus}`);
}

function pararGmailMonitor() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    errosConsecutivos = 0;
    state.statusConexoes.email = false;
    if (state.io) state.io.emit('status', state.statusConexoes);
    log('️', '[GMAIL] Monitor parado.');
}

module.exports = { iniciarGmailMonitor, pararGmailMonitor, enviarAlertaAdmin, extrairDadosDeImagem };
