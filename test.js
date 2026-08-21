
        // ===== Auth State =====
        var _authToken = sessionStorage.getItem('dashAuth') || '';

        function getAuthHeader() {
            if (!_authToken) return {};
            return { 'Authorization': 'Basic ' + _authToken };
        }

        // ===== Login Flow =====
        function fazerLogin() {
            var user = document.getElementById('login-user').value.trim();
            var pass = document.getElementById('login-pass').value;
            var errorEl = document.getElementById('login-error');
            var btn = document.getElementById('login-btn');

            if (!user || !pass) {
                errorEl.textContent = 'Preencha usuário e senha.';
                return;
            }

            btn.disabled = true;
            btn.textContent = ' Entrando...';
            errorEl.textContent = '';

            var token = btoa(user + ':' + pass);
            fetch(BASE_URL + '/api/auth/check', {
                headers: { 'Authorization': 'Basic ' + token }
            })
            .then(function(r) {
                if (!r.ok) throw new Error('invalid');
                return r.json();
            })
            .then(function(data) {
                _authToken = token;
                sessionStorage.setItem('dashAuth', token);
                mostrarApp();
            })
            .catch(function() {
                errorEl.textContent = ' Usuário ou senha incorretos.';
            })
            .finally(function() {
                btn.disabled = false;
                btn.textContent = 'Entrar';
            });
        }

        // Enter para login
        document.getElementById('login-pass').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') fazerLogin();
        });
        document.getElementById('login-user').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') document.getElementById('login-pass').focus();
        });

        function mostrarApp() {
            document.getElementById('login-overlay').classList.add('hidden');
            document.getElementById('app-header').style.display = 'flex';
            document.getElementById('app-nav').style.display = 'flex';
            document.getElementById('app-main').style.display = 'block';
            iniciarDashboard();
        }

        var BASE_URL = window.location.origin;

        // Auto-login se já tem token
        if (_authToken) {
            fetch(BASE_URL + '/api/auth/check', {
                headers: { 'Authorization': 'Basic ' + _authToken }
            })
            .then(function(r) {
                if (r.ok) { mostrarApp(); }
                else { sessionStorage.removeItem('dashAuth'); _authToken = ''; }
            })
            .catch(function() { });
        }

        // ===== Socket.io connection com proteção =====
        var socket = null;
        var servidorConectado = false;

        function iniciarDashboard() {
            setTimeout(function() { iniciarSocket(); }, 500);
            fetchStats();
            fetchChart();
            fetchHistorico();
            fetchLicenca();
            fetchGuilds();
            fetchGuildsForRules();
            fetchThreadMsg();
            setInterval(function() { fetchStats(); fetchChart(); }, 10000);
            setInterval(fetchHistorico, 30000);
            setInterval(fetchLicenca, 60000);
        }

        function iniciarSocket() {
            if (typeof io === 'undefined') {
                console.warn('Socket.io não disponível. Tentando CDN...');
                var script = document.createElement('script');
                script.src = 'https://cdn.socket.io/4.7.4/socket.io.min.js';
                script.onload = function () {
                    conectarSocket();
                };
                script.onerror = function () {
                    console.error('Não foi possível carregar Socket.io');
                    mostrarBannerConexao(false);
                };
                document.head.appendChild(script);
                return;
            }
            conectarSocket();
        }

        function conectarSocket() {
            if (typeof io === 'undefined') {
                mostrarBannerConexao(false);
                return;
            }

            try {
                // Aqui também, certifique-se de que a url correta é usada.
                socket = io(BASE_URL, {
                    reconnection: true,
                    reconnectionAttempts: Infinity,
                    reconnectionDelay: 2000,
                    reconnectionDelayMax: 10000,
                    timeout: 5000
                });

                socket.on('connect', function () {
                    servidorConectado = true;
                    mostrarBannerConexao(true);
                    console.log(' Conectado ao servidor via Socket.io');
                });

                socket.on('disconnect', function () {
                    servidorConectado = false;
                    mostrarBannerConexao(false);
                    console.warn(' Desconectado do servidor');
                });

                socket.on('connect_error', function () {
                    servidorConectado = false;
                    mostrarBannerConexao(false);
                });

                // Initial logs
                socket.on('logs-iniciais', function (logs) {
                    var fullLogs = document.getElementById('logs-full');
                    var miniLogs = document.getElementById('mini-logs');
                    if (logs && Array.isArray(logs)) {
                        logs.forEach(function (entry) {
                            addLogEntry(fullLogs, entry, 200);
                            addLogEntry(miniLogs, entry, 20);
                        });
                    }
                });

                // Real-time logs
                socket.on('log', function (entry) {
                    if (entry) {
                        addLogEntry(document.getElementById('logs-full'), entry, 200);
                        addLogEntry(document.getElementById('mini-logs'), entry, 20);
                    }
                });

                // New sale notification
                socket.on('nova-venda', function (venda) {
                    if (venda) {
                        showToast(' Nova venda! ' + (venda.nome || 'Cliente') + ' — ' + formatBRL(venda.valor || 0));
                        fetchStats();
                        fetchChart();
                        fetchHistorico();
                    }
                });

                // Bot status real-time
                socket.on('bot-status', function (data) {
                    if (data) {
                        _botRodando = data.rodando;
                        atualizarBotUI();
                    }
                });

                // Status updates com sync do Discord UI
                socket.on('status', function (statusUpdate) {
                    if (statusUpdate) {
                        updateBadge('badge-discord', statusUpdate.discord);
                        updateBadge('badge-email', statusUpdate.email);
                        updateBadge('badge-telegram', statusUpdate.telegram);
                        if (typeof statusUpdate.discord !== 'undefined') {
                            _discordConectado = statusUpdate.discord;
                            atualizarDiscordUI();
                        }
                    }
                });

            } catch (e) {
                console.error('Erro ao conectar Socket.io:', e);
                mostrarBannerConexao(false);
            }
        }

        function mostrarBannerConexao(conectado) {
            var banner = document.getElementById('connection-banner');
            if (conectado) {
                banner.className = 'connection-banner connected show';
                banner.textContent = ' Conectado ao servidor!';
                setTimeout(function () {
                    banner.classList.remove('show');
                }, 3000);
            } else {
                banner.className = 'connection-banner show';
                // Alterada a mensagem de erro para não indicar localhost.
                banner.innerHTML = '️ Sem conexão com o servidor. Aguarde...';
            }
        }

        // ===== Tab switching =====
        document.querySelectorAll('.nav-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                document.querySelectorAll('.nav-tab').forEach(function (t) { t.classList.remove('active'); });
                document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
                tab.classList.add('active');
                document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
            });
        });

        // ===== Clock =====
        function updateClock() {
            var now = new Date();
            document.getElementById('clock').textContent = now.toLocaleTimeString('pt-BR');
        }
        setInterval(updateClock, 1000);
        updateClock();

        // ===== Format currency =====
        function formatBRL(valor) {
            if (typeof valor !== 'number' || isNaN(valor)) valor = 0;
            return 'R$ ' + valor.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        }

        // ===== Format date =====
        function formatDate(ts) {
            try {
                var d = new Date(ts);
                return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            } catch (e) {
                return '—';
            }
        }

        // ===== Format log timestamp =====
        function formatLogTime(ts) {
            try {
                var d = new Date(ts);
                return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            } catch (e) {
                return '--:--:--';
            }
        }

        // ===== Fetch com proteção =====
        function fetchAPI(endpoint) {
            var url = BASE_URL + endpoint;
            var headers = getAuthHeader();
            return fetch(url, { headers: headers }).then(function (res) {
                if (res.status === 401) {
                    sessionStorage.removeItem('dashAuth');
                    _authToken = '';
                    location.reload();
                    throw new Error('Unauthorized');
                }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            });
        }

        // ===== Stats =====
        function fetchStats() {
            fetchAPI('/api/stats').then(function (data) {
                if (!data) return;

                if (data.hoje) {
                    document.getElementById('receita-hoje').textContent = formatBRL(data.hoje.receita);
                    document.getElementById('lucro-hoje').textContent = formatBRL(data.hoje.lucro);
                    var vendasHoje = data.hoje.vendas || 0;
                    document.getElementById('vendas-hoje').textContent = vendasHoje + ' venda' + (vendasHoje !== 1 ? 's' : '') + ' realizada' + (vendasHoje !== 1 ? 's' : '');
                }

                if (data.geral) {
                    document.getElementById('receita-geral').textContent = formatBRL(data.geral.receita);
                    var vendasGeral = data.geral.vendas || 0;
                    document.getElementById('vendas-geral').textContent = vendasGeral + ' venda' + (vendasGeral !== 1 ? 's' : '') + ' no total';
                }

                document.getElementById('filas-ativas').textContent = data.filasAtivas || 0;
                var pgPendentes = data.pagamentosPendentes || 0;
                document.getElementById('pagamentos-pendentes').textContent = pgPendentes + ' pagamento' + (pgPendentes !== 1 ? 's' : '') + ' pendente' + (pgPendentes !== 1 ? 's' : '');

                // Update connection badges
                if (data.conexoes) {
                    updateBadge('badge-discord', data.conexoes.discord);
                    updateBadge('badge-email', data.conexoes.email);
                    updateBadge('badge-telegram', data.conexoes.telegram);
                }

                // Se chegou aqui, servidor ta on
                if (!servidorConectado) {
                    servidorConectado = true;
                    var banner = document.getElementById('connection-banner');
                    banner.classList.remove('show');
                }

            }).catch(function (e) {
                // Silencioso - servidor offline
            });
        }

        function updateBadge(id, online) {
            var el = document.getElementById(id);
            if (el) {
                el.className = 'badge ' + (online ? 'online' : 'offline');
            }
        }

        // ===== Chart =====
        function fetchChart() {
            fetchAPI('/api/vendas-hora').then(function (data) {
                var container = document.getElementById('chart-vendas-hora');
                if (!container) return;
                container.innerHTML = '';

                if (!data || !Array.isArray(data)) data = [];

                // Create 24 hour slots
                var horasMap = {};
                data.forEach(function (d) { horasMap[parseInt(d.hora)] = d; });

                var maxQtd = 1;
                data.forEach(function (d) { if (d.qtd > maxQtd) maxQtd = d.qtd; });

                for (var h = 0; h < 24; h++) {
                    var info = horasMap[h];
                    var qtd = info ? info.qtd : 0;
                    var height = qtd > 0 ? Math.max(8, (qtd / maxQtd) * 140) : 4;

                    var group = document.createElement('div');
                    group.className = 'chart-bar-group';

                    var bar = document.createElement('div');
                    bar.className = 'chart-bar';
                    bar.style.height = height + 'px';
                    bar.title = h + 'h: ' + qtd + ' venda' + (qtd !== 1 ? 's' : '');

                    var label = document.createElement('div');
                    label.className = 'chart-bar-label';
                    label.textContent = h % 3 === 0 ? h + 'h' : '';

                    group.appendChild(bar);
                    group.appendChild(label);
                    container.appendChild(group);
                }
            }).catch(function (e) {
                // Silencioso
            });
        }

        // ===== History =====
        var allHistorico = [];

        function fetchHistorico() {
            fetchAPI('/api/historico').then(function (data) {
                if (Array.isArray(data)) {
                    allHistorico = data;
                    renderHistorico(allHistorico);
                }
            }).catch(function (e) {
                // Silencioso
            });
        }

        function renderHistorico(data) {
            var tbody = document.getElementById('tabela-historico');
            if (!tbody) return;

            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="icon"></div><p>Nenhuma venda encontrada.</p></div></td></tr>';
                return;
            }

            var html = '';
            for (var i = 0; i < data.length; i++) {
                var v = data[i];
                html += '<tr>';
                html += '<td style="color: var(--text-muted)">' + (data.length - i) + '</td>';
                html += '<td><strong>' + escapeHtml(v.nome) + '</strong></td>';
                html += '<td class="valor-cell">' + formatBRL(v.valor) + '</td>';
                html += '<td><span class="fila-tag">' + escapeHtml(v.fila || '—') + '</span></td>';
                html += '<td style="color: var(--text-secondary)">' + formatDate(v.data) + '</td>';
                html += '</tr>';
            }
            tbody.innerHTML = html;
        }

        function escapeHtml(text) {
            if (!text) return '';
            var div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Search filter
        document.getElementById('search-historico').addEventListener('input', function (e) {
            var q = e.target.value.toLowerCase();
            if (!q) { renderHistorico(allHistorico); return; }
            var filtered = allHistorico.filter(function (v) {
                return (v.nome && v.nome.toLowerCase().indexOf(q) !== -1) ||
                    (v.fila && v.fila.toLowerCase().indexOf(q) !== -1);
            });
            renderHistorico(filtered);
        });

        // ===== Logs =====
        function addLogEntry(container, entry, maxEntries) {
            if (!container || !entry) return;
            maxEntries = maxEntries || 200;

            var div = document.createElement('div');
            div.className = 'log-entry' + (entry.tipo === 'error' ? ' error' : '');
            div.innerHTML = '<span class="ts">' + formatLogTime(entry.timestamp) + '</span>' + escapeHtml(entry.texto);
            container.appendChild(div);

            // Limit entries
            while (container.children.length > maxEntries) {
                container.removeChild(container.firstChild);
            }

            // Auto-scroll
            container.scrollTop = container.scrollHeight;
        }

        // Toast
        function showToast(msg) {
            var toast = document.getElementById('toast');
            if (!toast) return;
            toast.textContent = msg;
            toast.classList.add('show');
            setTimeout(function () { toast.classList.remove('show'); }, 4000);
        }

        // Clear logs
        document.getElementById('btn-clear-logs').addEventListener('click', function () {
            document.getElementById('logs-full').innerHTML = '';
        });

        // ===== Bot Toggle (Geral) =====
        var _botRodando = true;
        var _discordConectado = true;

        function toggleBot() {
            var btn = document.getElementById('bot-toggle-btn');
            btn.disabled = true;
            btn.textContent = ' Aguarde...';

            var endpoint = _botRodando ? '/api/bot/parar' : '/api/bot/ligar';
            fetch(BASE_URL + endpoint, { method: 'POST' })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.ok) {
                        _botRodando = !_botRodando;
                        atualizarBotUI();
                        showToast(data.mensagem);
                    } else {
                        showToast(' ' + (data.mensagem || 'Erro'));
                    }
                })
                .catch(function() { showToast(' Erro de conexão'); })
                .finally(function() { btn.disabled = false; });
        }

        function toggleDiscord() {
            var btn = document.getElementById('discord-toggle-btn');
            btn.disabled = true;
            btn.textContent = ' Aguarde...';

            var endpoint = _discordConectado ? '/api/discord/desligar' : '/api/discord/ligar';
            fetch(BASE_URL + endpoint, { method: 'POST' })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.ok) {
                        _discordConectado = !_discordConectado;
                        atualizarDiscordUI();
                        showToast(data.mensagem);
                    } else {
                        showToast(' ' + (data.mensagem || 'Erro'));
                    }
                })
                .catch(function() { showToast(' Erro de conexão'); })
                .finally(function() { btn.disabled = false; });
        }

        function atualizarBotUI() {
            var statusText = document.getElementById('bot-status-text');
            var btn = document.getElementById('bot-toggle-btn');
            if (_botRodando) {
                statusText.className = 'bot-status-text running';
                statusText.textContent = '🟢 Rodando';
                btn.className = 'bot-toggle-btn stop';
                btn.textContent = ' Parar';
            } else {
                statusText.className = 'bot-status-text stopped';
                statusText.textContent = ' Parado';
                btn.className = 'bot-toggle-btn start';
                btn.textContent = '🟢 Ligar';
            }
        }

        function atualizarDiscordUI() {
            var statusText = document.getElementById('discord-status-text');
            var btn = document.getElementById('discord-toggle-btn');
            if (_discordConectado) {
                statusText.className = 'bot-status-text running';
                statusText.textContent = '🟢 Conectado';
                btn.className = 'bot-toggle-btn stop';
                btn.textContent = ' Desligar';
            } else {
                statusText.className = 'bot-status-text stopped';
                statusText.textContent = ' Desligado';
                btn.className = 'bot-toggle-btn start';
                btn.textContent = '🟢 Ligar';
            }
        }

        // ===== Licença =====
        function fetchLicenca() {
            fetchAPI('/api/licenca').then(function(data) {
                if (!data) return;
                var keyEl = document.getElementById('license-key');
                var expiryEl = document.getElementById('license-expiry');
                var iconEl = document.getElementById('license-icon');
                var badgeEl = document.getElementById('license-days-badge');

                keyEl.textContent = data.key || '---';

                if (data.vencimento) {
                    // Parse manual para evitar inversão dia/mês
                    var raw = data.vencimento;
                    var venc;
                    // Formato DD/MM/YYYY ou DD/MM/YYYY HH:mm
                    var partes = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
                    if (partes) {
                        var dia = parseInt(partes[1], 10);
                        var mes = parseInt(partes[2], 10) - 1;
                        var ano = parseInt(partes[3], 10);
                        var hora = partes[4] ? parseInt(partes[4], 10) : 0;
                        var min  = partes[5] ? parseInt(partes[5], 10) : 0;
                        venc = new Date(ano, mes, dia, hora, min);
                    } else {
                        venc = new Date(raw);
                    }
                    var agora = new Date();
                    var diffMs = venc.getTime() - agora.getTime();
                    var diffDias = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

                    var dd = String(venc.getDate()).padStart(2, '0');
                    var mm = String(venc.getMonth() + 1).padStart(2, '0');
                    var yyyy = venc.getFullYear();
                    var hh = String(venc.getHours()).padStart(2, '0');
                    var mi = String(venc.getMinutes()).padStart(2, '0');
                    var dataFormatada = dd + '/' + mm + '/' + yyyy;
                    var horaFormatada = hh + ':' + mi;

                    if (diffMs <= 0) {
                        expiryEl.textContent = 'Expirada em ' + dataFormatada + ' às ' + horaFormatada;
                        expiryEl.className = 'license-expiry expired';
                        iconEl.className = 'license-icon expired';
                        badgeEl.textContent = 'EXPIRADA';
                        badgeEl.className = 'license-days-badge expired';
                    } else if (diffDias <= 7) {
                        expiryEl.textContent = 'Vence em ' + dataFormatada + ' às ' + horaFormatada;
                        expiryEl.className = 'license-expiry warning';
                        iconEl.className = 'license-icon warning';
                        badgeEl.textContent = diffDias + ' dia' + (diffDias !== 1 ? 's' : '');
                        badgeEl.className = 'license-days-badge warning';
                    } else {
                        expiryEl.textContent = 'Vence em ' + dataFormatada + ' às ' + horaFormatada;
                        expiryEl.className = 'license-expiry active';
                        iconEl.className = 'license-icon active';
                        badgeEl.textContent = diffDias + ' dias';
                        badgeEl.className = 'license-days-badge active';
                    }
                } else {
                    expiryEl.textContent = data.status === 'ATIVA' ? 'Licença ativa (sem vencimento definido)' : 'Licença não verificada';
                    expiryEl.className = 'license-expiry active';
                }
            }).catch(function() { });
        }

        // ===== Auto-Responder =====
        var _arGuildId = '';
        var _arRegras = null;

        function fetchGuilds() {
            fetchAPI('/api/guilds').then(function(guilds) {
                var select = document.getElementById('ar-guild-select');
                if (!select) return;
                select.innerHTML = '<option value="">Selecione um servidor...</option>';
                if (!guilds || !Array.isArray(guilds) || guilds.length === 0) {
                    select.innerHTML = '<option value="">Nenhum servidor encontrado</option>';
                    return;
                }
                guilds.forEach(function(g) {
                    var opt = document.createElement('option');
                    opt.value = g.id;
                    opt.textContent = g.name + ' (' + g.memberCount + ' membros)';
                    select.appendChild(opt);
                });
            }).catch(function() {
                var select = document.getElementById('ar-guild-select');
                if (select) select.innerHTML = '<option value="">Erro ao carregar servidores</option>';
            });
        }

        document.getElementById('ar-guild-select').addEventListener('change', function(e) {
            _arGuildId = e.target.value;
            if (!_arGuildId) {
                document.getElementById('ar-rule-card').style.display = 'none';
                document.getElementById('ar-empty').style.display = 'block';
                document.getElementById('ar-categoria-select').innerHTML = '<option value="">Selecione um servidor primeiro</option>';
                return;
            }
            fetchCategorias(_arGuildId);
            fetchAutoResponder(_arGuildId);
        });

        function fetchCategorias(guildId) {
            fetchAPI('/api/guilds/' + guildId + '/channels').then(function(cats) {
                var select = document.getElementById('ar-categoria-select');
                if (!select) return;
                select.innerHTML = '<option value="">Todos os canais (sem filtro)</option>';
                if (cats && Array.isArray(cats)) {
                    cats.forEach(function(c) {
                        var opt = document.createElement('option');
                        opt.value = c.id;
                        opt.textContent = ' ' + c.name;
                        select.appendChild(opt);
                    });
                }
                // Se já tem regras carregadas, seleciona a categoria certa
                if (_arRegras && _arRegras.categoriaId) {
                    select.value = _arRegras.categoriaId;
                }
            }).catch(function() { });
        }

        function fetchAutoResponder(guildId) {
            fetchAPI('/api/autoresponder/' + guildId).then(function(regras) {
                _arRegras = regras;
                document.getElementById('ar-rule-card').style.display = 'block';
                document.getElementById('ar-empty').style.display = 'none';

                if (regras.categoriaId) {
                    document.getElementById('ar-categoria-select').value = regras.categoriaId;
                }

                if (regras.admOn) {
                    document.getElementById('ar-toggle-ativo').checked = regras.admOn.ativo !== false;
                    document.getElementById('ar-keywords').value = (regras.admOn.palavrasChave || []).join('\n');
                    document.getElementById('ar-resposta').value = regras.admOn.resposta || ' Adm SEMPRE ON.';
                    document.getElementById('ar-cooldown').value = Math.round((regras.admOn.cooldownMs || 60000) / 1000);
                }
                atualizarARStatusBadge();
            }).catch(function() {
                showToast(' Erro ao carregar regras');
            });
        }

        function atualizarARStatusBadge() {
            var badge = document.getElementById('ar-status-badge');
            var ativo = document.getElementById('ar-toggle-ativo').checked;
            if (ativo) {
                badge.className = 'ar-status-badge active';
                badge.textContent = '● Ativo';
            } else {
                badge.className = 'ar-status-badge inactive';
                badge.textContent = '● Inativo';
            }
        }

        document.getElementById('ar-toggle-ativo').addEventListener('change', atualizarARStatusBadge);

        function salvarAutoResponder() {
            if (!_arGuildId) {
                showToast(' Selecione um servidor primeiro');
                return;
            }

            var btn = document.getElementById('ar-save-btn');
            btn.disabled = true;
            btn.textContent = ' Salvando...';

            var keywordsRaw = document.getElementById('ar-keywords').value;
            var keywords = keywordsRaw.split('\n').map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; });

            var payload = {
                categoriaId: document.getElementById('ar-categoria-select').value || '',
                admOn: {
                    ativo: document.getElementById('ar-toggle-ativo').checked,
                    palavrasChave: keywords,
                    resposta: document.getElementById('ar-resposta').value || ' Adm SEMPRE ON.',
                    cooldownMs: Math.max(5, parseInt(document.getElementById('ar-cooldown').value) || 60) * 1000,
                }
            };

            fetch(BASE_URL + '/api/autoresponder/' + _arGuildId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.ok) {
                    showToast(' ' + data.mensagem);
                } else {
                    showToast(' ' + (data.error || 'Erro ao salvar'));
                }
            })
            .catch(function() { showToast(' Erro de conexão'); })
            .finally(function() {
                btn.disabled = false;
                btn.textContent = ' Salvar Regras';
            });
        }

        // ===== Server Rules =====
        var _srGuildId = '';
        var _srConfig = null;

        function fetchGuildsForRules() {
            fetchAPI('/api/guilds').then(function(guilds) {
                var select = document.getElementById('sr-guild-select');
                if (!select) return;
                select.innerHTML = '<option value="">Selecione um servidor...</option>';
                if (!guilds || !Array.isArray(guilds) || guilds.length === 0) {
                    select.innerHTML = '<option value="">Nenhum servidor encontrado</option>';
                    return;
                }
                guilds.forEach(function(g) {
                    var opt = document.createElement('option');
                    opt.value = g.id;
                    opt.textContent = g.name + ' (' + g.memberCount + ' membros)';
                    select.appendChild(opt);
                });
            }).catch(function() { });
        }

        document.getElementById('sr-guild-select').addEventListener('change', function(e) {
            _srGuildId = e.target.value;
            if (!_srGuildId) {
                document.getElementById('sr-rules-card').style.display = 'none';
                document.getElementById('sr-empty').style.display = 'block';
                document.getElementById('sr-categoria-select').innerHTML = '<option value="">Selecione um servidor primeiro</option>';
                return;
            }
            fetchCategoriasForRules(_srGuildId);
            fetchServerRules(_srGuildId);
        });

        function fetchCategoriasForRules(guildId) {
            fetchAPI('/api/guilds/' + guildId + '/channels').then(function(cats) {
                var select = document.getElementById('sr-categoria-select');
                if (!select) return;
                select.innerHTML = '<option value="">Nenhuma (usar escopo)</option>';
                if (cats && Array.isArray(cats)) {
                    cats.forEach(function(c) {
                        var opt = document.createElement('option');
                        opt.value = c.id;
                        opt.textContent = ' ' + c.name;
                        select.appendChild(opt);
                    });
                }
                if (_srConfig && _srConfig.categoriaId) {
                    select.value = _srConfig.categoriaId;
                }
            }).catch(function() { });
        }

        function fetchServerRules(guildId) {
            fetchAPI('/api/serverrules/' + guildId).then(function(config) {
                _srConfig = config;
                document.getElementById('sr-rules-card').style.display = 'block';
                document.getElementById('sr-empty').style.display = 'none';

                document.getElementById('sr-toggle-ativo').checked = config.ativo === true;
                document.getElementById('sr-regras-texto').value = config.regrasTexto || '';
                document.getElementById('sr-cooldown').value = Math.round((config.cooldownMs || 30000) / 1000);
                document.getElementById('sr-escopo-select').value = config.escopo || 'filas';

                if (config.categoriaId) {
                    document.getElementById('sr-categoria-select').value = config.categoriaId;
                }

                atualizarSRCharCount();
                atualizarSRStatusBadge();
            }).catch(function() {
                showToast(' Erro ao carregar regras do servidor');
            });
        }

        function atualizarSRStatusBadge() {
            var badge = document.getElementById('sr-status-badge');
            var ativo = document.getElementById('sr-toggle-ativo').checked;
            if (ativo) {
                badge.className = 'ar-status-badge active';
                badge.textContent = '● Ativo';
            } else {
                badge.className = 'ar-status-badge inactive';
                badge.textContent = '● Inativo';
            }
        }

        function atualizarSRCharCount() {
            var textarea = document.getElementById('sr-regras-texto');
            var counter = document.getElementById('sr-char-count');
            counter.textContent = (textarea.value || '').length.toLocaleString() + ' / 15.000 caracteres';
        }

        document.getElementById('sr-toggle-ativo').addEventListener('change', atualizarSRStatusBadge);
        document.getElementById('sr-regras-texto').addEventListener('input', atualizarSRCharCount);

        function salvarServerRules() {
            if (!_srGuildId) {
                showToast(' Selecione um servidor primeiro');
                return;
            }

            var btn = document.getElementById('sr-save-btn');
            btn.disabled = true;
            btn.textContent = ' Salvando...';

            var payload = {
                regrasTexto: document.getElementById('sr-regras-texto').value || '',
                ativo: document.getElementById('sr-toggle-ativo').checked,
                cooldownMs: Math.max(5, parseInt(document.getElementById('sr-cooldown').value) || 30) * 1000,
                categoriaId: document.getElementById('sr-categoria-select').value || '',
                escopo: document.getElementById('sr-escopo-select').value || 'filas',
            };

            fetch(BASE_URL + '/api/serverrules/' + _srGuildId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.ok) {
                    showToast(' ' + data.mensagem);
                } else {
                    showToast(' ' + (data.error || 'Erro ao salvar'));
                }
            })
            .catch(function() { showToast(' Erro de conexão'); })
            .finally(function() {
                btn.disabled = false;
                btn.textContent = ' Salvar Regras do Servidor';
            });
        }

        // ===== Thread Message =====
        var _tmConfig = null;

        function fetchThreadMsg() {
            fetchAPI('/api/thread-message').then(function(data) {
                _tmConfig = data;
                document.getElementById('tm-mensagem').value = data.mensagem || '';
                document.getElementById('tm-pix-toggle').checked = data.incluirPix === true;
                document.getElementById('tm-pix-key').value = data.pixChave || '';
                atualizarTmPreview();
            }).catch(function() { });
        }

        function atualizarTmPreview() {
            var msg = document.getElementById('tm-mensagem').value;
            var preview = document.getElementById('tm-preview');
            if (!msg.trim()) {
                preview.textContent = '(Mensagem padrão do bot será usada)';
                return;
            }
            var texto = msg;
            if (document.getElementById('tm-pix-toggle').checked) {
                var pix = document.getElementById('tm-pix-key').value || 'sua-chave-pix';
                texto += '\n\n\uD83D\uDCB3 Chave PIX: ' + pix;
            }
            preview.textContent = texto;
        }

        document.getElementById('tm-mensagem').addEventListener('input', atualizarTmPreview);
        document.getElementById('tm-pix-toggle').addEventListener('change', atualizarTmPreview);
        document.getElementById('tm-pix-key').addEventListener('input', atualizarTmPreview);

        function salvarThreadMsg() {
            var btn = document.getElementById('tm-save-btn');
            btn.disabled = true;
            btn.textContent = '\u23F3 Salvando...';

            var payload = {
                mensagem: document.getElementById('tm-mensagem').value || '',
                incluirPix: document.getElementById('tm-pix-toggle').checked,
                pixChave: document.getElementById('tm-pix-key').value || ''
            };

            fetch(BASE_URL + '/api/thread-message', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
                body: JSON.stringify(payload)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.ok) showToast('\u2705 ' + data.mensagem);
                else showToast('\u274c ' + (data.error || 'Erro ao salvar'));
            })
            .catch(function() { showToast('\u274c Erro de conex\u00e3o'); })
            .finally(function() {
                btn.disabled = false;
                btn.textContent = '\uD83D\uDCBE Salvar Mensagem';
            });
        }

        // ===== Override fetch calls that use POST to include auth =====
        var _origFetch = window.fetch;
        var _fetchOverridden = false;
        // All POST fetch calls in toggleBot, toggleDiscord, salvarAutoResponder, salvarServerRules
        // need auth headers. Let's patch the existing functions:
        var origToggleBot = window.toggleBot;
        var origToggleDiscord = window.toggleDiscord;

        // Patch toggleBot
        window.toggleBot = function() {
            var btn = document.getElementById('bot-toggle-btn');
            btn.disabled = true;
            btn.textContent = '\u23F3 Aguarde...';
            var endpoint = _botRodando ? '/api/bot/parar' : '/api/bot/ligar';
            fetch(BASE_URL + endpoint, { method: 'POST', headers: getAuthHeader() })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.ok) { _botRodando = !_botRodando; atualizarBotUI(); showToast(data.mensagem); }
                    else { showToast('\u274c ' + (data.mensagem || 'Erro')); }
                })
                .catch(function() { showToast('\u274c Erro de conex\u00e3o'); })
                .finally(function() { btn.disabled = false; });
        };

        window.toggleDiscord = function() {
            var btn = document.getElementById('discord-toggle-btn');
            btn.disabled = true;
            btn.textContent = '\u23F3 Aguarde...';
            var endpoint = _discordConectado ? '/api/discord/desligar' : '/api/discord/ligar';
            fetch(BASE_URL + endpoint, { method: 'POST', headers: getAuthHeader() })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.ok) { _discordConectado = !_discordConectado; atualizarDiscordUI(); showToast(data.mensagem); }
                    else { showToast('\u274c ' + (data.mensagem || 'Erro')); }
                })
                .catch(function() { showToast('\u274c Erro de conex\u00e3o'); })
                .finally(function() { btn.disabled = false; });
        };

        // Patch salvarAutoResponder to include auth
        window.salvarAutoResponder = function() {
            if (!_arGuildId) { showToast('\u274c Selecione um servidor primeiro'); return; }
            var btn = document.getElementById('ar-save-btn');
            btn.disabled = true;
            btn.textContent = '\u23F3 Salvando...';
            var keywordsRaw = document.getElementById('ar-keywords').value;
            var keywords = keywordsRaw.split('\n').map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; });
            var payload = {
                categoriaId: document.getElementById('ar-categoria-select').value || '',
                admOn: {
                    ativo: document.getElementById('ar-toggle-ativo').checked,
                    palavrasChave: keywords,
                    resposta: document.getElementById('ar-resposta').value || '\u2705 Adm SEMPRE ON.',
                    cooldownMs: Math.max(5, parseInt(document.getElementById('ar-cooldown').value) || 60) * 1000,
                }
            };
            fetch(BASE_URL + '/api/autoresponder/' + _arGuildId, {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
                body: JSON.stringify(payload)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.ok) showToast('\u2705 ' + data.mensagem);
                else showToast('\u274c ' + (data.error || 'Erro ao salvar'));
            })
            .catch(function() { showToast('\u274c Erro de conex\u00e3o'); })
            .finally(function() { btn.disabled = false; btn.textContent = '\uD83D\uDCBE Salvar Regras'; });
        };

        // Patch salvarServerRules to include auth
        window.salvarServerRules = function() {
            if (!_srGuildId) { showToast('\u274c Selecione um servidor primeiro'); return; }
            var btn = document.getElementById('sr-save-btn');
            btn.disabled = true;
            btn.textContent = '\u23F3 Salvando...';
            var payload = {
                regrasTexto: document.getElementById('sr-regras-texto').value || '',
                ativo: document.getElementById('sr-toggle-ativo').checked,
                cooldownMs: Math.max(5, parseInt(document.getElementById('sr-cooldown').value) || 30) * 1000,
                categoriaId: document.getElementById('sr-categoria-select').value || '',
                escopo: document.getElementById('sr-escopo-select').value || 'filas',
            };
            fetch(BASE_URL + '/api/serverrules/' + _srGuildId, {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
                body: JSON.stringify(payload)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.ok) showToast('\u2705 ' + data.mensagem);
                else showToast('\u274c ' + (data.error || 'Erro ao salvar'));
            })
            .catch(function() { showToast('\u274c Erro de conex\u00e3o'); })
            .finally(function() { btn.disabled = false; btn.textContent = '\uD83D\uDCBE Salvar Regras do Servidor'; });
        };

        // ===== Init =====
        updateClock();
    