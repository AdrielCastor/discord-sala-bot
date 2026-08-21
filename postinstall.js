/**
 * postinstall.js — Aplica patches automáticos nos node_modules
 * Executado automaticamente após "npm install"
 */
const fs = require('fs');
const path = require('path');

// PATCH 1: discord.js-selfbot-v13 — friend_source_flags null crash
const discordPatchPath = path.join(__dirname, 'node_modules', 'discord.js-selfbot-v13', 'src', 'managers', 'ClientUserSettingManager.js');
try {
    let content = fs.readFileSync(discordPatchPath, 'utf8');
    
    const oldCode = "if ('friend_source_flags' in data) {\n      this.addFriendFrom = {\n        all: data.friend_source_flags.all || false,";
    const newCode = "if ('friend_source_flags' in data && data.friend_source_flags) {\n      this.addFriendFrom = {\n        all: data.friend_source_flags.all || false,";
    
    if (content.includes(oldCode)) {
        content = content.replace(oldCode, newCode);
        fs.writeFileSync(discordPatchPath, content);
        console.log(' [POSTINSTALL] Patch aplicado: ClientUserSettingManager.js (friend_source_flags null fix)');
    } else if (content.includes("&& data.friend_source_flags)")) {
        console.log('ℹ️ [POSTINSTALL] ClientUserSettingManager.js já está patcheado');
    } else {
        // Tenta com \r\n (Windows)
        const oldCodeWin = oldCode.replace(/\n/g, '\r\n');
        const newCodeWin = newCode.replace(/\n/g, '\r\n');
        if (content.includes(oldCodeWin)) {
            content = content.replace(oldCodeWin, newCodeWin);
            fs.writeFileSync(discordPatchPath, content);
            console.log(' [POSTINSTALL] Patch aplicado (Windows): ClientUserSettingManager.js');
        } else {
            console.log('️ [POSTINSTALL] Não encontrou o trecho exato para patch. Tentando regex...');
            // Fallback: regex match
            const regex = /if \('friend_source_flags' in data\) \{/;
            if (regex.test(content)) {
                content = content.replace(regex, "if ('friend_source_flags' in data && data.friend_source_flags) {");
                fs.writeFileSync(discordPatchPath, content);
                console.log(' [POSTINSTALL] Patch aplicado via regex: ClientUserSettingManager.js');
            } else {
                console.log('️ [POSTINSTALL] Patch não aplicado - código fonte diferente do esperado');
            }
        }
    }
} catch (e) {
    console.log('️ [POSTINSTALL] Erro ao patchar discord.js:', e.message);
}

// PATCH 2: axios — redirecionar .cjs para .js no exports (para pkg)
const axiosPkgPath = path.join(__dirname, 'node_modules', 'axios', 'package.json');
try {
    const axiosPkg = JSON.parse(fs.readFileSync(axiosPkgPath, 'utf8'));
    
    // Copia axios.cjs como axios.js para compatibilidade com pkg
    const axioCjsPath = path.join(__dirname, 'node_modules', 'axios', 'dist', 'node', 'axios.cjs');
    const axioJsPath = path.join(__dirname, 'node_modules', 'axios', 'dist', 'node', 'axios.js');
    if (fs.existsSync(axioCjsPath) && !fs.existsSync(axioJsPath)) {
        fs.copyFileSync(axioCjsPath, axioJsPath);
        console.log(' [POSTINSTALL] Copiado axios.cjs -> axios.js');
    }

    console.log(' [POSTINSTALL] Patches concluídos!');
} catch (e) {
    console.log('️ [POSTINSTALL] Erro ao patchar axios:', e.message);
}

// PATCH 3: Garantir que googleapis está instalado (Gmail API PIX)
try {
    require.resolve('googleapis');
    console.log(' [POSTINSTALL] googleapis já instalado.');
} catch (_) {
    console.log(' [POSTINSTALL] googleapis não encontrado, instalando...');
    const { execSync } = require('child_process');
    try {
        execSync('npm install googleapis@latest --no-save', { stdio: 'inherit', cwd: __dirname });
        console.log(' [POSTINSTALL] googleapis instalado com sucesso!');
    } catch (e2) {
        console.log(' [POSTINSTALL] Falha ao instalar googleapis:', e2.message);
    }
}
