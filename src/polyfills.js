try {
    const streamWeb = require('stream/web');
    Object.assign(global, streamWeb);
    if (typeof globalThis !== 'undefined') Object.assign(globalThis, streamWeb);
} catch (e) { }

try {
    const buffer = require('buffer');
    global.Blob = buffer.Blob;
    if (typeof globalThis !== 'undefined') globalThis.Blob = buffer.Blob;
} catch (e) { }

global.File = class File { };
if (typeof globalThis !== 'undefined') globalThis.File = class File { };

if (typeof global.DOMException === 'undefined') {
    global.DOMException = class DOMException extends Error {
        constructor(message, name) { super(message); this.name = name || 'DOMException'; }
    };
    if (typeof globalThis !== 'undefined') globalThis.DOMException = global.DOMException;
}

if (!String.prototype.toWellFormed) {
    String.prototype.toWellFormed = function () {
        const s = String(this); let result = "";
        for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            if (code >= 0xD800 && code <= 0xDBFF) {
                const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
                if (next >= 0xDC00 && next <= 0xDFFF) { result += s[i] + s[i + 1]; i++; }
                else result += "\uFFFD";
            } else if (code >= 0xDC00 && code <= 0xDFFF) result += "\uFFFD";
            else result += s[i];
        }
        return result;
    };
}

// silencia timeout do telegram (gramjs)
function _isTelegramTimeout(args) {
    if (!args[0]) return false;
    if (args[0] instanceof Error && args[0].message === 'TIMEOUT' && args[0].stack && args[0].stack.includes('telegram/client/updates.js')) return true;
    if (typeof args[0] === 'string' && args[0].includes('TIMEOUT') && args[0].includes('telegram/client/updates.js')) return true;
    return false;
}

const _originalConsoleError = console.error;
console.error = function (...args) { if (!_isTelegramTimeout(args)) _originalConsoleError.apply(console, args); };

const _originalConsoleLog = console.log;
console.log = function (...args) { if (!_isTelegramTimeout(args)) _originalConsoleLog.apply(console, args); };

const _originalConsoleWarn = console.warn;
console.warn = function (...args) { if (!_isTelegramTimeout(args)) _originalConsoleWarn.apply(console, args); };
