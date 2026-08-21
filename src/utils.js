const QRCode = require('qrcode');

const RE_CONTROLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const RE_DIACRITICOS = /[\u0300-\u036f]/g;
const RE_NAO_ALFA = /[^a-z\s]/g;
const RE_ESPACOS = /\s+/g;
const RE_COMANDO_PAGO = /(?:^|\s|[.,!?;:])(?:j[aá]\s+)?(?:pg|pago|paguei|paguey|pgto|pag|pagou|pagando|paguii|pagoo|pagamento|ja\s*pg|já\s*pg|to\s+pago|tô\s+pago)(?:$|\s|[.,!?;:])/gi;
const RE_PALAVRAS_RUIDO = /\b(ta|tá|ja|já|to|tô|aqui|rapaz|mano|mana|irmao|irmão|agora|ae|aí|ai|bro|man|cara|deus|obg|obrigado|vlw|valeu|blz|beleza|ok|sim|nao|não|po|pô|vey|vei|lek|parça|truta)\b/gi;
const RE_SETA_VALOR = /[↳↩↪↵]\s*(?:R\$?\s*)?(\d+[.,]\d{2})/i;
const RE_VALOR_LABEL = /\*{0,2}Valor\*{0,2}[\s\S]{0,20}?(?:R\$\s*)?(\d+[.,]\d{2})/i;
const RE_VALOR_GENERICO = /R\$\s*(\d+[.,]\d{2})/i;
const RE_VALOR_DECIMAL_SOLO = /(?:^|\s)(\d+[.,]\d{2})(?:\s|$)/;
const RE_DETECTA_PAGO = /(?:^|\s|[.,!?;:])(?:j[aá]\s+)?(?:pg|pago|paguei|paguey|pgto|pag|pagou|pagando|paguii|pagoo|pagamento|ja\s*pg|já\s*pg|to\s+pago|tô\s+pago)(?:$|\s|[.,!?;:])/i;
const RE_HTML_TAGS = /<[^>]+>/g;

const BANCOS_PROIBIDOS = ['infinitypay'];
const BANCOS_MAP = [
    { palavras: ['bradesco'], nome: 'BRADESCO' },
    { palavras: ['itaú', 'itau'], nome: 'ITAU' },
    { palavras: ['caixa'], nome: 'CAIXA' },
    { palavras: ['banco do brasil', 'bb '], nome: 'BB' },
    { palavras: ['santander'], nome: 'SANTANDER' },
    { palavras: ['banco inter'], nome: 'INTER' },
    { palavras: ['c6'], nome: 'C6' },
    { palavras: ['picpay'], nome: 'PICPAY' },
    { palavras: ['mercado pago', 'mercadopago'], nome: 'MERCADO_PAGO' },
    { palavras: ['infinity pay', 'infinitypay', 'infinitepay'], nome: 'INFINITY_PAY' },
    { palavras: ['wise'], nome: 'WISE' },
    { palavras: ['xp investimentos', 'xp inc', 'conta digital xp', 'time conta digital'], nome: 'XP' },
];

function sanitizar(str, maxLen = 500) {
    if (!str || typeof str !== 'string') return '';
    return str.replace(RE_CONTROLE, '').substring(0, maxLen).trim();
}

function normalizarNome(nome) {
    if (!nome) return '';
    return sanitizar(nome)
        .toLowerCase()
        .normalize('NFD')
        .replace(RE_DIACRITICOS, '')
        .replace(RE_NAO_ALFA, '')
        .replace(RE_ESPACOS, ' ')
        .trim();
}

function nomeConfere(digitado, banco) {
    if (!digitado || !banco) return false;
    const d = normalizarNome(digitado);
    const b = normalizarNome(banco);
    if (!d || !b) return false;

    if (b.includes(d) || d.includes(b)) return true;

    const CONECTORES = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'del']);

    const pd = d.split(' ').filter(w => w.length >= 2);
    const pb = b.split(' ').filter(w => w.length >= 2);
    if (pd.length === 0 || pb.length === 0) return false;

    const pdReais = pd.filter(w => !CONECTORES.has(w));
    const pbReais = pb.filter(w => !CONECTORES.has(w));
    if (pdReais.length === 0 || pbReais.length === 0) return false;

    function palavraBate(a, b) {
        if (a === b) return true;
        if (a.length >= 3 && b.length >= 3) {
            if (a.startsWith(b) || b.startsWith(a)) return true;
        }
        return false;
    }

    const primeiroDigitado = pdReais[0];
    const primeiroBanco = pbReais[0];

    if (!palavraBate(primeiroDigitado, primeiroBanco)) {
        return false;
    }

    if (pdReais.length === 1) {
        return primeiroDigitado.length >= 4;
    }

    const nomesExtraDigitados = pdReais.slice(1);
    const nomesExtraBanco = pbReais.slice(1);

    for (const nomeExtra of nomesExtraDigitados) {
        const achou = nomesExtraBanco.some(nb => palavraBate(nomeExtra, nb));
        if (achou) return true;
    }

    return false;
}

function extrairValorDaString(txt) {
    if (!txt) return null;

    const matchSeta = txt.match(RE_SETA_VALOR);
    if (matchSeta) {
        const v = parseFloat(matchSeta[1].replace(',', '.'));
        if (v >= 0.20) return v;
    }

    const matchValor = txt.match(RE_VALOR_LABEL);
    if (matchValor) {
        const v = parseFloat(matchValor[1].replace(',', '.'));
        if (v >= 0.20) return v;
    }

    const matchGenerico = txt.match(RE_VALOR_GENERICO);
    if (matchGenerico) {
        const v = parseFloat(matchGenerico[1].replace(',', '.'));
        if (v >= 0.20) return v;
    }

    const matchDecimal = txt.match(RE_VALOR_DECIMAL_SOLO);
    if (matchDecimal) {
        const v = parseFloat(matchDecimal[1].replace(',', '.'));
        if (v >= 0.20 && v <= 100) return v;
    }

    return null;
}

function detectouPago(txt) {
    if (!txt) return false;
    return RE_DETECTA_PAGO.test(` ${txt} `);
}

function limparNomeDoPagamento(txtRaw) {
    return txtRaw
        .replace(RE_COMANDO_PAGO, ' ')
        .replace(RE_PALAVRAS_RUIDO, ' ')
        .replace(/[.,!?;:]+/g, ' ')
        .replace(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function detectarBanco(texto) {
    const t = texto.toLowerCase();
    const proibido = BANCOS_PROIBIDOS.some(bp => t.includes(bp));

    for (const entry of BANCOS_MAP) {
        if (entry.palavras.some(p => t.includes(p))) {
            return { banco: entry.nome, proibido };
        }
    }

    return { banco: 'NUBANK', proibido };
}

function criarRegistroPix(nomeCompleto, valor, banco, proibido) {
    const nomeSanitizado = sanitizar(nomeCompleto, 200);
    return {
        id: `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        nomeCompleto: nomeSanitizado,
        nomeNormalizado: normalizarNome(nomeCompleto),
        valor,
        horario: Date.now(),
        filaUsada: null,
        banco,
        proibido,
    };
}

function gerarPayloadPix(chavePix, recebedor, cidade, valor, txid = 'PIX') {
    const valorStr = valor.toFixed(2);
    const tlv = (id, val) => {
        const str = String(val);
        return `${id}${str.length.toString().padStart(2, '0')}${str}`;
    };
    const p = tlv('00', '01')
        + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', chavePix))
        + tlv('52', '0000') + tlv('53', '986')
        + (valor > 0 ? tlv('54', valorStr) : '')
        + tlv('58', 'BR')
        + tlv('59', recebedor.substring(0, 25).normalize('NFD').replace(RE_DIACRITICOS, ''))
        + tlv('60', cidade.substring(0, 15).normalize('NFD').replace(RE_DIACRITICOS, ''))
        + tlv('62', tlv('05', txid))
        + '6304';
    let crc = 0xFFFF;
    for (let i = 0; i < p.length; i++) {
        crc ^= p.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++)
            crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
    return p + (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

async function gerarQRCodeBuffer(payload) {
    return QRCode.toBuffer(payload, {
        type: 'png',
        width: 250,
        margin: 3,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
    });
}

module.exports = {
    sanitizar,
    normalizarNome,
    nomeConfere,
    extrairValorDaString,
    detectouPago,
    limparNomeDoPagamento,
    detectarBanco,
    criarRegistroPix,
    gerarPayloadPix,
    gerarQRCodeBuffer,
    RE_HTML_TAGS,
};