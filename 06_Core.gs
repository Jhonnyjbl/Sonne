// ============================================================
// Core.gs — Sistema de Mensagens (Consolidado)
// Consolidado de: Mensagens.gs + MensagensPrivadas.gs + StatusMensagem.gs + RespostaMensagem.gs + Encaminhamento.gs
// ============================================================

// ── MENSAGENS (Mensagens.gs) ───────────────────────────────────

// Chave de fila de mensagens recentes no cache (por canal)
function ckFila(canal) { return 'fila_' + String(canal).toLowerCase() + '_v' + SISTEMA_VERSAO; }

// ── Cache seguro: nunca estoura o limite de 100KB do CacheService ─
function _cachePutSafe(cache, chave, valor, ttl) {
  try {
    if (!valor || valor.length > _CACHE_MAX_BYTES) return; // silenciosamente ignora se muito grande
    cache.put(chave, valor, ttl);
  } catch(e) {
    // "Invalid argument" do CacheService — dado muito grande, ignorar sem quebrar o fluxo
    Logger.log('_cachePutSafe: dado ignorado para ' + chave + ' (' + (valor ? valor.length : 0) + ' bytes): ' + e.message);
  }
}

// ── Formatar hora para exibição (tratar objetos Date e strings) ─
function _formatarHora(valor) {
  if (!valor) return '';
  
  // Se for um objeto Date, formatar como HH:mm:ss
  if (valor instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(valor, tz, 'HH:mm:ss');
  }
  
  // Se for string, tentar extrair apenas a parte HH:mm:ss
  var str = String(valor);
  
  // Se já estiver no formato HH:mm:ss, retornar
  if (/^\d{2}:\d{2}:\d{2}$/.test(str)) return str;
  
  // Se for string de data completa do JavaScript, extrair apenas a hora
  if (str.includes('GMT') || str.includes('(')) {
    // Tentar converter para Date e extrair hora
    try {
      var d = new Date(str);
      if (!isNaN(d.getTime())) {
        var tz = Session.getScriptTimeZone();
        return Utilities.formatDate(d, tz, 'HH:mm:ss');
      }
    } catch(e) {}
  }
  
  // Se for string no formato HH:mm, adicionar segundos
  if (/^\d{1,2}:\d{2}$/.test(str)) {
    var parts = str.split(':');
    var h = parts[0].padStart(2, '0');
    var m = parts[1].padStart(2, '0');
    return h + ':' + m + ':00';
  }
  
  // Retornar original se não conseguir formatar
  return str;
}

// ── Formatar data e hora para exibição ─────────────────────────
function _formatarDataHora(valor) {
  if (!valor) return '';
  
  // Se for um objeto Date, formatar como dd/MM/yyyy HH:mm:ss
  if (valor instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(valor, tz, 'dd/MM/yyyy HH:mm:ss');
  }
  
  // Se for string, tentar formatar
  var str = String(valor);
  
  // Já está no formato correto dd/MM/yyyy HH:mm:ss
  if (/^\d{2}\/\d{2}\/\d{4}\s\d{2}:\d{2}:\d{2}$/.test(str)) return str;
  
  // Se for string de data completa do JavaScript, formatar
  if (str.includes('GMT') || str.includes('(')) {
    try {
      var d = new Date(str);
      if (!isNaN(d.getTime())) {
        var tz = Session.getScriptTimeZone();
        return Utilities.formatDate(d, tz, 'dd/MM/yyyy HH:mm:ss');
      }
    } catch(e) {}
  }
  
  // Tentar parsear formato ISO ou similar
  try {
    var d = new Date(str);
    if (!isNaN(d.getTime())) {
      var tz = Session.getScriptTimeZone();
      return Utilities.formatDate(d, tz, 'dd/MM/yyyy HH:mm:ss');
    }
  } catch(e) {}
  
  // Retornar original se não conseguir formatar
  return str;
}

// ── Salvar mensagem ───────────────────────────────────────
function salvarMensagem(seuNome, mensagem, destinatario, emailUsuario, idRespondida) {
  var trava = LockService.getScriptLock();
  try {
    if (!trava.tryLock(500)) return 'Erro: Sistema ocupado. Tente novamente.';

    var em = normalizarEmail(emailUsuario);
    if (em) {
      var blk = JSON.parse(verificarUsuarioBloqueado(em));
      if (blk.bloqueado) return 'Erro: Conta bloqueada. Contate o administrador.';
      
      // Verificar punição ativa (mute ou ban)
      var punicao = JSON.parse(verificarPunicaoAtiva(em));
      if (punicao.punicao) {
        var tipo = punicao.punicao.tipo;
        if (tipo === 'MUTE') {
          return 'Erro: Você está silenciado (mute) até ' + punicao.punicao.dataFim + '.';
        } else if (tipo === 'BAN_TEMP' || tipo === 'BAN_PERM') {
          return 'Erro: Sua conta está banida. ' + (tipo === 'BAN_TEMP' ? 'Ban expira em: ' + punicao.punicao.dataFim : 'Contate o administrador para recorrer.');
        }
      }
      
      // Verificar rate limit
      var rateLimit = verificarRateLimitMensagem(em);
      if (!rateLimit.permitido) {
        return 'Erro: ' + rateLimit.motivo;
      }
    }

    var msgLimpa = String(mensagem||'').trim();
    if (!msgLimpa) return 'Erro: Mensagem vazia.';
    if (msgLimpa.length > MAX_TAMANHO_MSG) return 'Erro: Mensagem muito longa (máx. ' + MAX_TAMANHO_MSG + ' chars).';

    var dest = String(destinatario||'grupo_geral').trim() || 'grupo_geral';

    // ── Validar que o usuário pertence ao grupo de destino ──
    if (!_verificarAcessoGrupo(dest, em, seuNome)) {
      return 'Erro: Você não é membro deste grupo.';
    }

    // Sanitizar mensagem para XSS protection
    msgLimpa = sanitizarMensagem(msgLimpa);

    // ── Verificar moderação automática ─────────────────────────
    var modAuto = JSON.parse(verificarModeracaoAuto(dest, msgLimpa, em));
    if (!modAuto.permitido) {
      return 'Erro: Mensagem bloqueada pela moderação automática (palavra: ' + (modAuto.palavra || '') + ').';
    }

    // Extrair e processar menções
    var mencoes = extrairMencoes(msgLimpa);
    
    // Processar links para HTML clicável
    var msgComLinks = processarLinks(msgLimpa);

    var nm   = String(seuNome||'Visitante').trim() || 'Visitante';
    var now  = new Date();
    var tz   = Session.getScriptTimeZone();
    var id   = Utilities.getUuid();
    var dataS = Utilities.formatDate(now, tz, 'dd/MM/yyyy');
    var horaS = Utilities.formatDate(now, tz, 'HH:mm:ss');
    var ts    = now.getTime();

    // ── 1. Salvar no Sheets (persistência) ──────────────
    var aba = _garantirAbaMensagens();
    var linhaNum = aba.getLastRow() + 1;
    aba.appendRow([dataS, horaS, nm, dest, msgComLinks, nm, id, '{}', '', 'ENVIADA',
                   String(idRespondida||''), msgLimpa, mencoes.join(','), '']);
    // Removido flush() para melhorar performance - Google Sheets gerencia automaticamente

    // ── 2. Adicionar na fila do cache (leitura rápida) ──
    // Buscar avatar do remetente usando cache
    var avatarRemetente = '';
    try {
      var cacheKey = 'avatar_' + em.toLowerCase();
      var cachedAvatar = cache.get(cacheKey);
      if (cachedAvatar) {
        avatarRemetente = cachedAvatar;
      } else {
        var usuarios = JSON.parse(listarTodosUsuarios());
        var usuario = usuarios.filter(function(u){ return u.email.toLowerCase() === em.toLowerCase(); })[0];
        if (usuario && usuario.avatar) {
          avatarRemetente = usuario.avatar;
          cache.put(cacheKey, avatarRemetente, 600); // Cache por 10 minutos
        }
      }
    } catch(x){}
    
    var novaMsg = {
      idUnico: linhaNum, idMsg: id,
      data: dataS, hora: horaS, ts: ts,
      remetente: nm, destinatario: dest,
      mensagem: msgComLinks, textoOriginal: msgLimpa,
      reacoes: '{}', editada: '', statusMsg: 'ENVIADA',
      idRespondida: String(idRespondida||''),
      mencoes: mencoes,
      arquivo: '',
      avatar: avatarRemetente
    };
    _adicionarNaFila(dest, novaMsg);

    // ── 3. Invalidar cache de carga inicial ─────────────
    _invalidarCacheMsgs(dest);

    try { registrarAtividade(nm, emailUsuario); } catch(x){}

    return JSON.stringify({ ok:true, idMensagem:id });
  } catch(e) {
    Logger.log('Erro em salvarMensagem: ' + e.message);
    try { registrarLogSistema('ERRO', seuNome, 'Erro ao enviar', e.message); } catch(x){}
    return 'Erro: ' + e.message;
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Fila no CacheService ──────────────────────────────────

function _adicionarNaFila(canal, msg) {
  try {
    var cache = CacheService.getScriptCache();
    var ck    = ckFila(canal);
    var raw   = cache.get(ck);
    var fila  = raw ? JSON.parse(raw) : [];
    fila.push(msg);
    // Manter apenas as últimas FILA_MAX mensagens
    if (fila.length > FILA_MAX) fila = fila.slice(fila.length - FILA_MAX);
    _cachePutSafe(cache, ck, JSON.stringify(fila), 300); // TTL 5 min
  } catch(e) { /* falha silenciosa — Sheets é a fonte verdadeira */ }
}

function _lerFila(canal) {
  try {
    var raw = CacheService.getScriptCache().get(ckFila(canal));
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

// ── Invalidar fila do cache ao editar/apagar/reagir ──────
function _invalidarFilaMsg(canal, idMsg, novaMsg) {
  try {
    var cache = CacheService.getScriptCache();
    var ck    = ckFila(canal);
    var raw   = cache.get(ck);
    if (!raw) return;
    var fila = JSON.parse(raw);
    for (var i = 0; i < fila.length; i++) {
      if (fila[i].idMsg === idMsg) {
        if (novaMsg) { fila[i] = novaMsg; } // atualizar
        else { fila.splice(i, 1); }          // remover
        break;
      }
    }
    cache.put(ck, JSON.stringify(fila), 300);
  } catch(e){}
}

// ── Carregar histórico (híbrido cache + Sheets com paginação) ──────────
function carregarHistorico(seuNome, idGrupoAtual, aPartirDe, pagina, tamanhoPagina, emailUsuario) {
  idGrupoAtual = idGrupoAtual || 'grupo_geral';
  aPartirDe    = parseInt(aPartirDe) || 0;
  pagina       = parseInt(pagina) || 1;
  tamanhoPagina = parseInt(tamanhoPagina) || 50;

  // ── Validar acesso ao grupo ───────────────────────────────
  var em = normalizarEmail(emailUsuario);
  if (!_verificarAcessoGrupo(idGrupoAtual, em, seuNome)) {
    return JSON.stringify({ historico:[], usuarios:[], digitando:[],
                            versao:SISTEMA_VERSAO, ts:Date.now(),
                            erro:'Sem permissão para acessar este grupo.' });
  }

  var cache = CacheService.getScriptCache();
  var ck    = ckMsgs(idGrupoAtual);

  // ── Carga inicial (aPartirDe === 0): usar cache de carga ──
  if (aPartirDe === 0) {
    var cached = cache.get(ck);
    if (cached) {
      try {
        var d = JSON.parse(cached);
        d.digitando = _obterDigitando(idGrupoAtual, seuNome);

        // Mesclar fila do cache com o histórico cacheado
        // para garantir que msgs recentes (enviadas após o cache) apareçam
        var fila = _lerFila(idGrupoAtual);
        if (fila && fila.length > 0) {
          var idsExistentes = {};
          (d.historico||[]).forEach(function(m){ idsExistentes[m.idMsg] = true; });
          fila.forEach(function(m) {
            if (!idsExistentes[m.idMsg]) d.historico.push(m);
          });
        }
        return JSON.stringify(d);
      } catch(x){}
    }
  }

  // ── Delta poll (aPartirDe > 0): ler da fila do cache PRIMEIRO ──
  if (aPartirDe > 0) {
    var fila = _lerFila(idGrupoAtual);
    if (fila !== null) {
      // Fila existe — filtrar apenas as msgs novas ou atualizadas
      var novas = fila.filter(function(m){ 
        // Incluir se timestamp for maior (mensagem nova)
        // OU se timestamp for igual mas reações/editada mudou (mensagem atualizada)
        return m.ts > aPartirDe || (m.ts === aPartirDe && (m.reacoes !== '{}' || m.editada === 'Sim' || m.statusMsg !== 'ENVIADA'));
      });
      
      // Incluir mensagens atualizadas recentemente (reações, edições, status)
      var atualizacoes = obterMensagensAtualizadas(idGrupoAtual);
      var idsJaIncluidos = {};
      novas.forEach(function(m){ idsJaIncluidos[m.idMsg] = true; });
      
      Object.keys(atualizacoes).forEach(function(idMsg){
        if (!idsJaIncluidos[idMsg]) {
          var atualizacao = atualizacoes[idMsg];
          // Buscar a mensagem atualizada na fila
          var msgAtualizada = fila.filter(function(m){ return m.idMsg === idMsg; })[0];
          if (msgAtualizada) {
            novas.push(msgAtualizada);
          }
        }
      });
      
      var usuarios = _montarUsuariosSimples(novas, cache, seuNome);
      return JSON.stringify({
        historico:  novas,
        usuarios:   usuarios,
        digitando:  _obterDigitando(idGrupoAtual, seuNome),
        versao:     SISTEMA_VERSAO,
        ts:         Date.now(),
        fonte:      'cache' // para debug
      });
    }
    // Fila fria — ir ao Sheets
    return _carregarHistoricoSemLock(seuNome, idGrupoAtual, aPartirDe, cache, ck, pagina, tamanhoPagina);
  }

  // Carga inicial sem cache — usar lock para evitar concorrência
  var trava = LockService.getScriptLock();
  try {
    if (!trava.tryLock(2000)) {
      var bkp = cache.get(ck + '_bkp');
      if (bkp) {
        try {
          var db = JSON.parse(bkp);
          db.digitando = _obterDigitando(idGrupoAtual, seuNome);
          return JSON.stringify(db);
        } catch(x){}
      }
      return JSON.stringify({ historico:[], usuarios:[], digitando:[], erro:'Sistema ocupado' });
    }
    var resultado = _carregarHistoricoSemLock(seuNome, idGrupoAtual, 0, cache, ck, pagina, tamanhoPagina);

    // Ao carregar do Sheets, popular a fila do cache com as msgs recentes
    try {
      var resObj = JSON.parse(resultado);
      if (resObj.historico && resObj.historico.length > 0) {
        var ultimas = resObj.historico.slice(-FILA_MAX);
        cache.put(ckFila(idGrupoAtual), JSON.stringify(ultimas), 300);
      }
    } catch(x){}

    return resultado;
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Helper: montar usuários a partir de lista de msgs ────
function _montarUsuariosSimples(msgs, cache, meuNome) {
  var mapa = {};
  (msgs||[]).forEach(function(m) {
    var nm = m.remetente;
    if (!nm || mapa[nm]) return;
    mapa[nm] = { nome:nm, online: cache.get(ckOnline(nm)) === 'sim' };
  });
  return Object.keys(mapa).map(function(k){ return mapa[k]; });
}

function _carregarHistoricoSemLock(seuNome, idGrupoAtual, aPartirDe, cache, ck, pagina, tamanhoPagina) {
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ historico:[], usuarios:[] });
    _garantirColunas(aba);

    var total  = aba.getLastRow();
    if (total < 2) return JSON.stringify({ historico:[], usuarios:[], digitando:[], ts:Date.now() });

    var tz     = Session.getScriptTimeZone();
    var lista  = [];
    var statusAtualizados = [];

    // ── Otimização 1: para delta, ler apenas as últimas N linhas ──
    var inicio;
    if (aPartirDe > 0) {
      // Para delta: ler apenas as últimas DELTA_MAX_LINHAS linhas
      var maxLinhas = (typeof DELTA_MAX_LINHAS !== 'undefined') ? DELTA_MAX_LINHAS : 200;
      inicio = Math.max(1, total - maxLinhas);
    } else {
      // Para carga inicial: ler as últimas 500 linhas para garantir que encontramos histórico do grupo
      inicio = Math.max(1, total - 500);
    }

    var numLinhas = total - inicio;
    if (numLinhas <= 0) return JSON.stringify({ historico:[], usuarios:[], digitando:[], ts:Date.now() });

    // Ler apenas as linhas necessárias em vez de getDataRange() completo
    var dados = aba.getRange(inicio + 1, 1, numLinhas, 14).getValues();

    for (var i = 0; i < dados.length; i++) {
      var r = dados[i];
      if (!r || r.length < 10) continue;
      if (String(r[3]||'').trim() !== idGrupoAtual) continue;

      var dataS = r[0] instanceof Date ? Utilities.formatDate(r[0],tz,'dd/MM/yyyy') : String(r[0]||'');
      var horaS = r[1] instanceof Date ? Utilities.formatDate(r[1],tz,'HH:mm:ss')  : String(r[1]||'');
      var tsMsg = _parseTsMensagem(dataS, horaS);

      if (aPartirDe > 0 && tsMsg <= aPartirDe) {
        // Coletar atualizações de status para mensagens já conhecidas pelo cliente
        var stJ = String(r[9]||'ENVIADA').trim().toUpperCase();
        if (stJ === 'ENTREGUE' || stJ === 'LIDA') {
          var idJ = String(r[6]||'').trim();
          if (idJ) statusAtualizados.push({ idMsg: idJ, statusMsg: stJ });
        }
        continue;
      }

      var status  = String(r[9]||'ATIVA').trim().toUpperCase();
      var texto   = status === 'APAGADA' ? '🗑️ Mensagem apagada.' : String(r[4]||'').trim();
      var idMsg   = String(r[6]||'').trim() || ('R' + (inicio + i + 1));
      var remetenteNome = String(r[2]||'').trim();

      // Buscar email do remetente usando cache de usuários
      var remetenteEmail = '';
      var avatarRemetente = '';
      try {
        var mapaUsuarios = obterMapaUsuarios();
        var usuario = mapaUsuarios[remetenteNome.toLowerCase()];
        if (usuario) {
          avatarRemetente = usuario.avatar || '';
          remetenteEmail = usuario.email || '';
        }
      } catch(x){}

      lista.push({
        idUnico:      inicio + i + 1,
        idMsg:        idMsg,
        data:         dataS,
        hora:         horaS,
        ts:           tsMsg,
        remetente:    remetenteNome,
        remetenteEmail: remetenteEmail,
        destinatario: String(r[3]||'').trim(),
        mensagem:     texto,
        textoOriginal:String(r.length>=12?r[11]:r[4]||'').trim(),
        reacoes:      String(r[7]||'{}'),
        editada:      String(r[8]||''),
        statusMsg:    status,
        idRespondida: String(r[10]||'').trim(),
        mencoes:      String(r[12]||'').split(',').filter(Boolean),
        arquivo:      String(r[13]||''),
        avatar:       avatarRemetente
      });
    }

    // ── Otimização 2: Paginados no backend apenas para carga inicial (aPartirDe === 0) ──
    var historicoRetorno = lista;
    var totalPaginas = 1;

    if (aPartirDe === 0) {
      var totalMsgs = lista.length;
      totalPaginas = Math.ceil(totalMsgs / tamanhoPagina) || 1;
      // Paginar de trás para frente (mais recentes primeiro)
      var endSlice = totalMsgs - (pagina - 1) * tamanhoPagina;
      var startSlice = Math.max(0, endSlice - tamanhoPagina);
      historicoRetorno = (endSlice > 0) ? lista.slice(startSlice, endSlice) : [];
    }

    var usuarios  = _montarUsuarios(historicoRetorno, cache, seuNome);
    var resultado = {
      historico:  historicoRetorno,
      usuarios:   usuarios,
      digitando:  _obterDigitando(idGrupoAtual, seuNome),
      versao:     SISTEMA_VERSAO,
      totalSheet: total - 1,
      carregados: historicoRetorno.length,
      ts:         Date.now(),
      pagina:     pagina,
      tamanhoPagina: tamanhoPagina,
      totalPaginas: totalPaginas,
      statusAtualizados: (aPartirDe > 0) ? statusAtualizados : []
    };

    if (aPartirDe === 0) {
      var json = JSON.stringify(resultado);
      if (json.length > _CACHE_MAX_BYTES) {
        // Payload muito grande — guardar apenas as últimas 30 msgs no cache
        var res30 = JSON.parse(JSON.stringify(resultado));
        res30.historico = resultado.historico.slice(-30);
        var json30 = JSON.stringify(res30);
        _cachePutSafe(cache, ck,        json30, CACHE_TTL_MSGS);
        _cachePutSafe(cache, ck+'_bkp', json30, CACHE_TTL_MSGS * 4);
      } else {
        _cachePutSafe(cache, ck,        json, CACHE_TTL_MSGS);
        _cachePutSafe(cache, ck+'_bkp', json, CACHE_TTL_MSGS * 4);
      }
    }
    return JSON.stringify(resultado);
  } catch(e) {
    return JSON.stringify({ erro:e.message, historico:[], usuarios:[] });
  }
}

// ── Marcar como lido ──────────────────────────────────────
// Versão otimizada: só atualiza células específicas, não reescreve tudo
function marcarComoLido(emailUsuario, canal) {
  if (!emailUsuario || !canal) return;
  // Evitar escrever na planilha toda vez — usar cache para debounce (30s)
  var ck = 'lido_' + String(emailUsuario).toLowerCase() + '_' + String(canal).toLowerCase();
  var cache = CacheService.getScriptCache();
  if (cache.get(ck)) return; // já marcou recentemente
  cache.put(ck, '1', 30); // só reescreve a cada 30s por usuário/canal

  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba || aba.getLastRow() < 2) return;
    // Otimização: ler apenas as últimas 200 linhas em vez da planilha inteira
    var total = aba.getLastRow();
    var maxLinhas = 200;
    var inicio = Math.max(1, total - maxLinhas);
    var numLinhas = total - inicio;
    
    if (numLinhas <= 0) return;
    
    var dados = aba.getRange(inicio + 1, 1, numLinhas, 6).getValues();
    var em     = String(emailUsuario||'').trim().toLowerCase();
    var can    = String(canal||'').trim().toLowerCase();
    var linhasAtualizar = [];

    for (var i = 0; i < dados.length; i++) {
      if (String(dados[i][3]||'').trim().toLowerCase() !== can) continue;
      var leitores = String(dados[i][5]||'').trim();
      var lista = leitores ? leitores.split(',').map(function(x){return x.trim().toLowerCase();}) : [];
      if (lista.indexOf(em) === -1) {
        linhasAtualizar.push({ linha: inicio + i + 1, leitores: leitores ? leitores + ',' + emailUsuario : emailUsuario });
      }
    }
    // Escrever apenas as células necessárias (não reescrever toda planilha)
    linhasAtualizar.forEach(function(item) {
      aba.getRange(item.linha, 6).setValue(item.leitores);
    });
    if (linhasAtualizar.length > 0) {
      SpreadsheetApp.flush();
      _invalidarCacheMsgs(canal);
    }
  } catch(e) { /* falha silenciosa */ }
}

// ── Apagar mensagem ───────────────────────────────────────
function apagarMinhaMensagem(idReferencia, seuNome, verificacaoJson) {
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(8000);
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada.' });
    _garantirColunas(aba);
    var ver = {}; try { ver = verificacaoJson ? JSON.parse(verificacaoJson) : {}; } catch(x){}
    ver.remetente = String(seuNome).trim();
    var linha = _localizarLinha(aba, idReferencia, ver);
    if (linha < 0) return JSON.stringify({ ok:false, erro:'Mensagem não encontrada.' });
    var row  = aba.getRange(linha,1,1,14).getValues()[0];
    var stat = String(row[9]||'ATIVA').toUpperCase();
    if (stat === 'APAGADA') return JSON.stringify({ ok:false, erro:'Já apagada.' });
    var dataMsg = parsearDataHoraMensagem(String(row[0]), String(row[1]));
    if (dataMsg && (Date.now() - dataMsg.getTime()) > MINUTOS_APAGAR_MSG * 60000)
      return JSON.stringify({ ok:false, erro:'Prazo de '+MINUTOS_APAGAR_MSG+' min expirou.' });
    aba.getRange(linha,10).setValue('APAGADA');
    SpreadsheetApp.flush();
    var canal = String(row[3]);
    _invalidarCacheMsgs(canal);
    // Atualizar fila do cache para refletir apagamento instantaneamente
    _invalidarFilaMsg(canal, String(row[6]||''), {
      idUnico: linha, idMsg: String(row[6]||''),
      data: String(row[0]), hora: String(row[1]),
      ts: _parseTsMensagem(String(row[0]), String(row[1])),
      remetente: String(row[2]), destinatario: canal,
      mensagem: '🗑️ Mensagem apagada.', textoOriginal: String(row[11]||row[4]||''),
      reacoes: String(row[7]||'{}'), editada: String(row[8]||''),
      statusMsg: 'APAGADA', idRespondida: String(row[10]||''),
      mencoes: String(row[12]||'').split(',').filter(Boolean),
      arquivo: String(row[13]||'')
    });
    registrarLogSistema('CHAT', seuNome, 'Mensagem apagada', idReferencia);
    return JSON.stringify({ ok:true });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
  finally   { if (trava.hasLock()) trava.releaseLock(); }
}

// ── Editar mensagem ───────────────────────────────────────
function editarMensagem(idReferencia, seuNome, novaMensagem, verificacaoJson) {
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(8000);
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada.' });
    _garantirColunas(aba);
    var ver = {}; try { ver = verificacaoJson ? JSON.parse(verificacaoJson) : {}; } catch(x){}
    ver.remetente = String(seuNome).trim();
    var linha = _localizarLinha(aba, idReferencia, ver);
    if (linha < 0) return JSON.stringify({ ok:false, erro:'Mensagem não encontrada.' });
    var row  = aba.getRange(linha,1,1,14).getValues()[0];
    var stat = String(row[9]||'ATIVA').toUpperCase();
    if (stat === 'APAGADA') return JSON.stringify({ ok:false, erro:'Não edite mensagens apagadas.' });
    if (String(row[8]||'') === 'Sim') return JSON.stringify({ ok:false, erro:'Já foi editada uma vez.' });
    var dataMsg = parsearDataHoraMensagem(String(row[0]), String(row[1]));
    if (dataMsg && (Date.now() - dataMsg.getTime()) > MINUTOS_EDITAR_MSG * 60000)
      return JSON.stringify({ ok:false, erro:'Prazo de '+MINUTOS_EDITAR_MSG+' min expirou.' });
    var nova = String(novaMensagem||'').trim();
    if (!nova || nova.length > MAX_TAMANHO_MSG) return JSON.stringify({ ok:false, erro:'Texto inválido.' });
    // Sanitizar nova mensagem
    nova = sanitizarMensagem(nova);
    aba.getRange(linha,5).setValue(nova);
    aba.getRange(linha,9).setValue('Sim');
    aba.getRange(linha,10).setValue('EDITADA');
    SpreadsheetApp.flush();
    var canal = String(row[3]);
    _invalidarCacheMsgs(canal);
    // Atualizar fila do cache com o texto editado
    _invalidarFilaMsg(canal, String(row[6]||''), {
      idUnico: linha, idMsg: String(row[6]||''),
      data: String(row[0]), hora: String(row[1]),
      ts: _parseTsMensagem(String(row[0]), String(row[1])),
      remetente: String(row[2]), destinatario: canal,
      mensagem: nova, textoOriginal: String(row[11]||row[4]||''),
      reacoes: String(row[7]||'{}'), editada: 'Sim',
      statusMsg: 'EDITADA', idRespondida: String(row[10]||''),
      mencoes: String(row[12]||'').split(',').filter(Boolean),
      arquivo: String(row[13]||'')
    });
    registrarLogSistema('CHAT', seuNome, 'Mensagem editada', idReferencia);
    return JSON.stringify({ ok:true });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
  finally   { if (trava.hasLock()) trava.releaseLock(); }
}

// ── Reações ───────────────────────────────────────────────
function adicionarReacao(idReferencia, seuNome, emoji, verificacaoJson) {
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada.' });
    _garantirColunas(aba);
    var ver = {}; try { ver = verificacaoJson ? JSON.parse(verificacaoJson) : {}; } catch(x){}
    var linha = _localizarLinha(aba, idReferencia, ver);
    if (linha < 0) return JSON.stringify({ ok:false, erro:'Mensagem não encontrada.' });
    var row  = aba.getRange(linha,1,1,14).getValues()[0];
    if (String(row[9]||'').toUpperCase() === 'APAGADA')
      return JSON.stringify({ ok:false, erro:'Mensagem apagada.' });
    var mapa = {};
    try { mapa = JSON.parse(String(row[7]||'{}')||'{}'); } catch(x){ mapa={}; }
    var nm = String(seuNome).toLowerCase().trim();
    if (!mapa[emoji]) mapa[emoji] = [];
    var idx = mapa[emoji].indexOf(nm);
    if (idx !== -1) { mapa[emoji].splice(idx,1); if (!mapa[emoji].length) delete mapa[emoji]; }
    else             mapa[emoji].push(nm);
    aba.getRange(linha,8).setValue(JSON.stringify(mapa));
    SpreadsheetApp.flush();
    var canal = String(row[3]);
    _invalidarCacheMsgs(canal);
    // Registrar atualização de reação no cache para propagação em tempo real
    registrarMensagemAtualizada(canal, String(row[6]||''), 'reacao');
    // Atualizar reações na fila do cache
    _invalidarFilaMsg(canal, String(row[6]||''), {
      idUnico: linha, idMsg: String(row[6]||''),
      data: String(row[0]), hora: String(row[1]),
      ts: _parseTsMensagem(String(row[0]), String(row[1])),
      remetente: String(row[2]), destinatario: canal,
      mensagem: String(row[4]||''), textoOriginal: String(row[11]||row[4]||''),
      reacoes: JSON.stringify(mapa), editada: String(row[8]||''),
      statusMsg: String(row[9]||'ATIVA'), idRespondida: String(row[10]||''),
      mencoes: String(row[12]||'').split(',').filter(Boolean),
      arquivo: String(row[13]||'')
    });
    return JSON.stringify({ ok:true, reacoes:mapa });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

// ── "Digitando..." ────────────────────────────────────────
function notificarDigitando(canal, nome) {
  try {
    var ck  = 'typing_' + String(canal||'').toLowerCase();
    var raw = CacheService.getScriptCache().get(ck);
    var mapa = {}; try { mapa = JSON.parse(raw||'{}'); } catch(x){}
    mapa[String(nome).toLowerCase()] = { nome: String(nome), ts: Date.now() };
    CacheService.getScriptCache().put(ck, JSON.stringify(mapa), 10);
    return JSON.stringify({ ok:true });
  } catch(e) { return JSON.stringify({ ok:false }); }
}

// ── Busca ─────────────────────────────────────────────────
function buscarMensagens(idGrupo, query, emailUsuario) {
  if (!query) return JSON.stringify([]);
  // Verificar acesso antes de buscar
  if (!_verificarAcessoGrupo(idGrupo, normalizarEmail(emailUsuario), '')) {
    return JSON.stringify([]);
  }
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify([]);
    
    // Otimização: ler apenas as últimas 500 linhas em vez da planilha inteira
    var total = aba.getLastRow();
    var maxLinhas = 500;
    var inicio = Math.max(1, total - maxLinhas);
    var numLinhas = total - inicio;
    
    if (numLinhas <= 0) return JSON.stringify([]);
    
    var dados = aba.getRange(inicio + 1, 1, numLinhas, 12).getValues();
    var q = String(query).toLowerCase();
    var res = [];
    for (var i = 0; i < dados.length; i++) {
      if (String(dados[i][3]||'').trim() !== idGrupo) continue;
      if (String(dados[i][9]||'').toUpperCase() === 'APAGADA') continue;
      if (String(dados[i][4]||'').toLowerCase().indexOf(q) >= 0) {
        res.push({ idMsg:String(dados[i][6]||''), remetente:String(dados[i][2]||''),
                   mensagem:String(dados[i][4]||''), textoOriginal:String(dados[i][11]||dados[i][4]||''),
                   data:String(dados[i][0]||''), hora:String(dados[i][1]||'') });
      }
    }
    return JSON.stringify(res);
  } catch(e) { return JSON.stringify([]); }
}

// ── Busca Global (todas as conversas) ───────────────────────
function buscarGlobal(query, emailUsuario, limite) {
  if (!query) return JSON.stringify({ ok:false, erro:'Query vazia.' });
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  
  try {
    var max = limite || 100;
    var q = String(query).toLowerCase();
    var resultados = [];
    
    // Buscar em grupos que o usuário participa
    var grupos = JSON.parse(listarGruposUsuario(em));
    if (grupos.ok && grupos.grupos) {
      grupos.grupos.forEach(function(g) {
        var aba = obterAbaPorNome(ABA_MENSAGENS);
        if (!aba) return;
        
        // Otimização: ler apenas as últimas 500 linhas em vez da planilha inteira
        var total = aba.getLastRow();
        var maxLinhas = 500;
        var inicio = Math.max(1, total - maxLinhas);
        var numLinhas = total - inicio;
        
        if (numLinhas <= 0) return;
        
        var dados = aba.getRange(inicio + 1, 1, numLinhas, 12).getValues();
        for (var i = 0; i < dados.length && resultados.length < max; i++) {
          if (String(dados[i][3]) !== g.id) continue;
          if (String(dados[i][9]||'').toUpperCase() === 'APAGADA') continue;
          
          var msg = String(dados[i][4]||'').toLowerCase();
          var remetente = String(dados[i][2]||'').toLowerCase();
          
          if (msg.indexOf(q) >= 0 || remetente.indexOf(q) >= 0) {
            resultados.push({
              idMsg: String(dados[i][6]||''),
              mensagem: String(dados[i][4]||''),
              remetente: String(dados[i][2]||''),
              grupo: g.nome,
              idGrupo: g.id,
              data: String(dados[i][0]||''),
              hora: String(dados[i][1]||''),
              tipo: 'grupo'
            });
          }
        }
      });
    }
    
    // Buscar em conversas privadas
    var convs = JSON.parse(listarConversasPrivadas(em));
    if (convs.ok && convs.conversas) {
      convs.conversas.forEach(function(c) {
        var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
        if (!aba) return;
        
        // Otimização: ler apenas as últimas 200 linhas em vez da planilha inteira
        var total = aba.getLastRow();
        var maxLinhas = 200;
        var inicio = Math.max(1, total - maxLinhas);
        var numLinhas = total - inicio;
        
        if (numLinhas <= 0) return;
        
        var dados = aba.getRange(inicio + 1, 1, numLinhas, 13).getValues();
        for (var i = 0; i < dados.length && resultados.length < max; i++) {
          if (String(dados[i][0]) !== c.idConversa) continue;
          if (String(dados[i][8]||'').toUpperCase() === 'APAGADA') continue;
          
          var msg = String(dados[i][3]||'').toLowerCase();
          var remetente = String(dados[i][2]||'').toLowerCase();
          
          if (msg.indexOf(q) >= 0 || remetente.indexOf(q) >= 0) {
            resultados.push({
              idMsg: String(dados[i][6]||''),
              mensagem: String(dados[i][3]||''),
              remetente: String(dados[i][2]||''),
              grupo: c.outroNome,
              idGrupo: c.idConversa,
              data: String(dados[i][4]||''),
              hora: String(dados[i][5]||''),
              tipo: 'privada'
            });
          }
        }
      });
    }
    
    // Ordenar por data (mais recentes primeiro)
    resultados.sort(function(a, b) {
      return new Date(b.data + ' ' + b.hora) - new Date(a.data + ' ' + a.hora);
    });
    
    // Limitar resultado
    if (resultados.length > max) {
      resultados = resultados.slice(0, max);
    }
    
    return JSON.stringify({ ok:true, resultados:resultados, total:resultados.length });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Helpers privados ──────────────────────────────────────

// ── Verificação centralizada de acesso ao grupo ───────────
// Retorna true se o email (ou nome como fallback) tem acesso ao grupo.
// Grupos públicos ('todos') são acessíveis a todos.
// Grupos do tipo 'grupo_geral' são sempre acessíveis.
function _verificarAcessoGrupo(idGrupo, email, nome) {
  if (!idGrupo || idGrupo === 'grupo_geral') return true;
  try {
    var em = normalizarEmail(email);
    // Admin do sistema sempre tem acesso
    if (em && _isAdminSistema(em)) return true;

    var grupos = JSON.parse(_listarTodosGruposRaw());
    var encontrado = false;
    var membroValido = false;
    for (var i = 0; i < grupos.length; i++) {
      if (String(grupos[i].id) !== String(idGrupo)) continue;
      encontrado = true;
      var membros = String(grupos[i].membros||'').toLowerCase().trim();
      if (membros === 'todos') {
        membroValido = true;
        break;
      }
      var lista = membros.replace(/;/g, ',').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      if (em && lista.indexOf(em) !== -1) {
        membroValido = true;
        break;
      }
      if (nome) {
        var emailPorNome = _obterEmailPorNome(nome);
        if (emailPorNome && lista.indexOf(emailPorNome) !== -1) {
          membroValido = true;
          break;
        }
      }
    }

    if (encontrado && membroValido) return true;

    // Se não encontrou ou não era membro no cache, forçar recarga da planilha para confirmar
    // (fallback para membros adicionados recentemente na planilha diretamente)
    grupos = JSON.parse(_listarTodosGruposRaw(true));
    for (var i = 0; i < grupos.length; i++) {
      if (String(grupos[i].id) !== String(idGrupo)) continue;
      var membros = String(grupos[i].membros||'').toLowerCase().trim();
      if (membros === 'todos') return true;
      var lista = membros.replace(/;/g, ',').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      if (em && lista.indexOf(em) !== -1) return true;
      if (nome) {
        var emailPorNome = _obterEmailPorNome(nome);
        if (emailPorNome && lista.indexOf(emailPorNome) !== -1) return true;
      }
      return false;
    }
    return false; // grupo não encontrado — negar por segurança
  } catch(e) {
    Logger.log('_verificarAcessoGrupo erro: ' + e.message);
    return true; // falha silenciosa — não bloquear o sistema
  }
}
function _obterEmailPorNome(nome) {
  try {
    var nm = String(nome||'').trim().toLowerCase();
    if (!nm) return null;
    var lista = JSON.parse(listarTodosUsuarios());
    for (var i = 0; i < lista.length; i++) {
      if (String(lista[i].nome||'').trim().toLowerCase() === nm) return lista[i].email;
    }
  } catch(e) {}
  return null;
}

// Fallback: verifica membership pelo nome (menos preciso, usado só se email não encontrado)
function verificarMembroGrupoPorNome(idGrupo, nome) {
  try {
    var grupos = JSON.parse(_listarTodosGruposRaw());
    var g = grupos.filter(function(x){ return String(x.id) === String(idGrupo); })[0];
    if (!g) return false;
    var membros = String(g.membros||'');
    if (membros.toLowerCase() === 'todos') return true;
    // Buscar o email correspondente ao nome para comparar com a lista de membros
    var email = _obterEmailPorNome(nome);
    if (email) {
      return membros.split(',').some(function(m){ return m.trim().toLowerCase() === email; });
    }
    return false;
  } catch(e) { return false; }
}

function listarMembrosGrupo(idGrupo) {
  try {
    var grupos = JSON.parse(_listarTodosGruposRaw());
    var g = grupos.filter(function(x){ return String(x.id) === String(idGrupo); })[0];
    if (!g) return JSON.stringify({ ok:false, erro:'Grupo não encontrado', membros:[] });
    
    var membrosStr = String(g.membros||'');
    if (membrosStr.toLowerCase() === 'todos') {
      // Retornar todos os usuários
      var todosUsuarios = JSON.parse(listarTodosUsuarios());
      return JSON.stringify({ ok:true, membros:todosUsuarios });
    }
    
    // Resolver emails para obter nomes e avatares
    var emails = membrosStr.replace(/;/g,',').split(',').map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
    var membros = _resolverNomesMembros(emails);
    
    return JSON.stringify({ ok:true, membros:membros });
  } catch(e) {
    Logger.log('Erro em listarMembrosGrupo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message, membros:[] });
  }
}

function _garantirAbaMensagens() {
  Logger.log('_garantirAbaMensagens iniciado, buscando aba: ' + ABA_MENSAGENS);
  var aba = obterAbaPorNome(ABA_MENSAGENS);
  Logger.log('Aba obtida: ' + (aba ? aba.getName() : 'null'));
  if (!aba) {
    Logger.log('Aba não encontrada, criando nova aba');
    aba = obterPlanilhaChat().insertSheet(ABA_MENSAGENS);
    var est = obterEstruturaAbas().Mensagens;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
    Logger.log('Aba criada: ' + aba.getName());
  }
  return aba;
}

function _garantirColunas(aba) {
  if (aba.getLastColumn() >= 14) return;
  var est = obterEstruturaAbas().Mensagens;
  aplicarCabecalhoEAjustes(aba, est.headers, null);
}

function _localizarLinha(aba, idRef, verificacao) {
  var ref = String(idRef||'').trim();
  if (!ref) return -1;
  
  // Otimização: se for referência de linha (R123), usar diretamente
  if (ref.startsWith('R')) {
    var n = parseInt(ref.substring(1),10);
    var total = aba.getLastRow();
    if (n > 0 && n <= total) {
      var dados = aba.getRange(n, 1, 1, 14).getValues()[0];
      if (verificacao && verificacao.remetente) {
        var rem = String(dados[2]||'').trim();
        if (rem.toLowerCase() !== verificacao.remetente.toLowerCase()) return -1;
      }
      return n;
    }
    return -1;
  }
  
  // Para busca por ID, ler apenas as últimas 500 linhas
  var total = aba.getLastRow();
  var maxLinhas = 500;
  var inicio = Math.max(1, total - maxLinhas);
  var numLinhas = total - inicio;
  
  if (numLinhas <= 0) return -1;
  
  var dados = aba.getRange(inicio + 1, 1, numLinhas, 14).getValues();
  var linha = -1;
  
  for (var i = 0; i < dados.length; i++) {
    if (String(dados[i][6]||'').trim() === ref) { 
      linha = inicio + i + 1;
      break; 
    }
  }
  
  if (linha > 0 && verificacao && verificacao.remetente) {
    var rem = String(dados[linha - inicio - 1][2]||'').trim();
    if (rem.toLowerCase() !== verificacao.remetente.toLowerCase()) return -1;
  }
  return linha;
}

function _invalidarCacheMsgs(canal) {
  var ck = ckMsgs(canal);
  CacheService.getScriptCache().remove(ck);
  CacheService.getScriptCache().remove(ck+'_bkp');
}

function _parseTsMensagem(dataStr, horaStr) {
  try {
    var d = dataStr.split('/'), h = horaStr.split(':');
    if (d.length !== 3) return 0;
    return new Date(+d[2],+d[1]-1,+d[0],+(h[0]||0),+(h[1]||0),+(h[2]||0)).getTime();
  } catch(x){ return 0; }
}

function _montarUsuarios(lista, cache, meuNome) {
  var mapa = {};
  lista.forEach(function(m){
    var nm = m.remetente;
    if (!nm || mapa[nm]) return;
    mapa[nm] = { nome:nm, online: cache.get(ckOnline(nm)) === 'sim' };
  });
  return Object.keys(mapa).map(function(k){ return mapa[k]; });
}

function _obterDigitando(canal, exceto) {
  var ck  = 'typing_' + String(canal||'').toLowerCase();
  var raw = CacheService.getScriptCache().get(ck);
  if (!raw) return [];
  var mapa = {}; try { mapa = JSON.parse(raw); } catch(x){ return []; }
  var agora = Date.now();
  return Object.keys(mapa).filter(function(k){
    var item = mapa[k];
    return item && (agora - item.ts < 3000) && item.nome.toLowerCase() !== String(exceto||'').toLowerCase();
  }).map(function(k){ return mapa[k].nome; });
}

// ── MENSAGENS PRIVADAS (MensagensPrivadas.gs) ─────────────────

// ── Criar conversa privada ─────────────────────────────────
function criarConversaPrivada(email1, email2, nome1, nome2) {
  var em1 = normalizarEmail(email1);
  var em2 = normalizarEmail(email2);
  if (!em1 || !em2) return JSON.stringify({ ok:false, erro:'Emails inválidos.' });
  if (em1 === em2) return JSON.stringify({ ok:false, erro:'Não pode criar conversa consigo mesmo.' });

  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(4000);
    
    // Gerar ID único para conversa (ordem alfabética para consistência)
    var emails = [em1, em2].sort();
    var idConversa = 'dm_' + emails[0] + '_' + emails[1];
    
    // Verificar se conversa já existe
    var aba = _garantirAbaConversasPrivadas();
    // Otimização: ler apenas as últimas 500 linhas em vez da planilha inteira
    var total = aba.getLastRow();
    var maxLinhas = 500;
    var inicio = Math.max(1, total - maxLinhas);
    var numLinhas = total - inicio;
    
    if (numLinhas > 0) {
      var dados = aba.getRange(inicio + 1, 1, numLinhas, 7).getValues();
      for (var i = 0; i < dados.length; i++) {
        if (String(dados[i][0]) === idConversa) {
          return JSON.stringify({ ok:true, idConversa:idConversa, jaExiste:true });
        }
      }
    }
    
    // Criar nova conversa
    var agora = new Date().toLocaleString();
    aba.appendRow([idConversa, em1, nome1, em2, nome2, agora, 'ATIVA']);
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(ckConversasPrivadas());
    registrarLogSistema('DM', nome1, 'Conversa criada', 'Com:' + nome2);
    
    return JSON.stringify({ ok:true, idConversa:idConversa, jaExiste:false });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Listar conversas privadas do usuário ───────────────────
function listarConversasPrivadas(emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

  try {
    var cache = CacheService.getScriptCache();
    var ck = ckConversasPrivadas() + '_' + em;
    var raw = cache.get(ck);

    if (raw) {
      return raw;
    }

    var aba = obterAbaPorNome(ABA_CONVERSAS_PRIVADAS);
    if (!aba) {
      return JSON.stringify({ ok:true, conversas:[] });
    }

    // Otimização: ler apenas as últimas 500 linhas em vez da planilha inteira
    var total = aba.getLastRow();
    var maxLinhas = 500;
    var inicio = Math.max(1, total - maxLinhas);
    var numLinhas = total - inicio;
    
    if (numLinhas <= 0) return JSON.stringify({ ok:true, conversas:[] });
    
    var dados = aba.getRange(inicio + 1, 1, numLinhas, 7).getValues();
    var conversas = [];

    // Obter contagem de não lidas
    var naoLidasData = JSON.parse(obterNaoLidas(emailUsuario));
    var porGrupo = naoLidasData.porGrupo || {};
    var privadasNaoLidasTotal = porGrupo['privadas'] || 0;

    for (var i = 0; i < dados.length; i++) {
      var row = dados[i];
      var idConversa = String(row[0]);
      var participante1 = String(row[1]);
      var participante2 = String(row[3]);
      var status = String(row[6]||'ATIVA').toUpperCase();

      if (status !== 'ATIVA') continue;

        // Verificar se usuário participa desta conversa
      if (participante1 === em || participante2 === em) {
        var outroEmail = participante1 === em ? participante2 : participante1;
        var outroNome = _obterNomeUsuario(outroEmail);
        
        // Buscar avatar do outro usuário
        var avatarOutro = '';
        try {
          var usuarios = JSON.parse(listarTodosUsuarios());
          var usuario = usuarios.filter(function(u){ return u.email.toLowerCase() === outroEmail.toLowerCase(); })[0];
          if (usuario && usuario.avatar) avatarOutro = usuario.avatar;
        } catch(x){}
        
        // Verificar se o outro usuário está online usando a chave correta do heartbeat
        var online = false;
        try {
          var cacheOnline = CacheService.getScriptCache();
          // heartbeat salva em ckOnline(nome) = 'onl_' + nome.toLowerCase()
          online = cacheOnline.get(ckOnline(outroNome)) === 'sim';
        } catch(e) {
          online = false;
        }

        Logger.log('Conversa encontrada: outroEmail=' + outroEmail + ', outroNome=' + outroNome + ', online=' + online);

        conversas.push({
          idConversa: idConversa,
          outroEmail: outroEmail,
          outroNome: outroNome,
          dataCriacao: String(row[5]),
          status: status,
          online: online,
          avatar: avatarOutro,
          naoLidas: privadasNaoLidasTotal // Simplificado - todas as privadas não lidas
        });
      }
    }

    Logger.log('Total de conversas encontradas: ' + conversas.length);

    // Ordenar por data de criação (mais recente primeiro)
    conversas.sort(function(a, b) {
      var dataA = new Date(a.dataCriacao || 0).getTime();
      var dataB = new Date(b.dataCriacao || 0).getTime();
      return dataB - dataA;
    });

    var resultado = JSON.stringify({ ok:true, conversas:conversas });
    _cachePutSafe(cache, ck, resultado, 60); // Cache 1 minuto
    Logger.log('Resultado: ' + resultado.substring(0, 200));
    return resultado;
  } catch(e) {
    Logger.log('Erro em listarConversasPrivadas: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Enviar mensagem privada ─────────────────────────────────
function enviarMensagemPrivada(emailRemetente, nomeRemetente, emailDestinatario, mensagem, idRespondida) {
  Logger.log('enviarMensagemPrivada chamado: remetente=' + emailRemetente + ', destinatario=' + emailDestinatario + ', mensagem=' + mensagem + ', idRespondida=' + idRespondida);
  var emRem = normalizarEmail(emailRemetente);
  var emDest = normalizarEmail(emailDestinatario);
  if (!emRem || !emDest) return JSON.stringify({ ok:false, erro:'Emails inválidos.' });
  if (emRem === emDest) return JSON.stringify({ ok:false, erro:'Não pode enviar mensagem para si mesmo.' });

  var msgLimpa = String(mensagem||'').trim();
  if (!msgLimpa) return JSON.stringify({ ok:false, erro:'Mensagem vazia.' });
  if (msgLimpa.length > MAX_TAMANHO_MSG) return JSON.stringify({ ok:false, erro:'Mensagem muito longa.' });

  // Sanitizar mensagem
  msgLimpa = sanitizarMensagem(msgLimpa);
  Logger.log('Mensagem sanitizada: ' + msgLimpa);
  
  // Processar links para HTML clicável
  var msgComLinks = processarLinks(msgLimpa);
  Logger.log('Mensagem com links processados: ' + msgComLinks);

  var trava = LockService.getScriptLock();
  try {
    if (!trava.tryLock(500)) return JSON.stringify({ ok:false, erro:'Sistema ocupado. Tente novamente.' });

    // Verificar se usuários estão bloqueados
    var blkRem = JSON.parse(verificarUsuarioBloqueado(emRem));
    if (blkRem.bloqueado) return JSON.stringify({ ok:false, erro:'Sua conta está bloqueada.' });

    var blkDest = JSON.parse(verificarUsuarioBloqueado(emDest));
    if (blkDest.bloqueado) return JSON.stringify({ ok:false, erro:'Destinatário bloqueado.' });

    // Obter ou criar conversa
    var emails = [emRem, emDest].sort();
    var idConversa = 'dm_' + emails[0] + '_' + emails[1];
    Logger.log('ID da conversa: ' + idConversa);

    // Verificar se conversa existe
    var abaConv = _garantirAbaConversasPrivadas();
    // Otimização: ler apenas as últimas 500 linhas em vez da planilha inteira
    var totalConv = abaConv.getLastRow();
    var maxLinhasConv = 500;
    var inicioConv = Math.max(1, totalConv - maxLinhasConv);
    var numLinhasConv = totalConv - inicioConv;
    
    var conversaExiste = false;
    if (numLinhasConv > 0) {
      var dadosConv = abaConv.getRange(inicioConv + 1, 1, numLinhasConv, 7).getValues();
      for (var i = 0; i < dadosConv.length; i++) {
        if (String(dadosConv[i][0]) === idConversa) {
          conversaExiste = true;
          break;
        }
      }
    }
    Logger.log('Conversa existe: ' + conversaExiste);

    if (!conversaExiste) {
      // Criar conversa
      var nomeDest = _obterNomeUsuario(emDest);
      abaConv.appendRow([idConversa, emRem, nomeRemetente, emDest, nomeDest, new Date().toLocaleString(), 'ATIVA']);
      // Removido flush() para melhorar performance
      Logger.log('Conversa criada');
    }

    // Salvar mensagem
    var abaMsg = _garantirAbaMensagensPrivadas();
    var now = new Date();
    var tz = Session.getScriptTimeZone();
    var id = Utilities.getUuid();

    abaMsg.appendRow([
      idConversa,
      emRem,
      nomeRemetente,
      msgComLinks,
      Utilities.formatDate(now, tz, 'dd/MM/yyyy'),
      Utilities.formatDate(now, tz, 'HH:mm:ss'),
      id,
      now.getTime(),
      'ENVIADA',
      '{}',
      '',
      msgLimpa,
      String(idRespondida || '')
    ]);
    // Removido flush() para melhorar performance
    Logger.log('Mensagem privada salva na planilha, idMensagem=' + id);

    // Invalidar cache
    CacheService.getScriptCache().remove(ckConversasPrivadas() + '_' + emRem);
    CacheService.getScriptCache().remove(ckConversasPrivadas() + '_' + emDest);
    CacheService.getScriptCache().remove(ckMensagensPrivadas(idConversa));
    Logger.log('Cache invalidado');

    registrarLogSistema('DM', nomeRemetente, 'Mensagem enviada', 'Para:' + emDest);

    Logger.log('enviarMensagemPrivada concluído com sucesso');
    return JSON.stringify({ ok:true, idConversa:idConversa, idMensagem:id });
  } catch(e) {
    Logger.log('Erro em enviarMensagemPrivada: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Carregar histórico de conversa privada ─────────────────
function carregarMensagensPrivadas(idConversa, aPartirDe) {
  Logger.log('carregarMensagensPrivadas chamado: idConversa=' + idConversa + ', aPartirDe=' + aPartirDe);
  if (!idConversa) return JSON.stringify({ ok:false, erro:'ID da conversa não informado.' });

  aPartirDe = parseInt(aPartirDe) || 0;

  try {
    var cache = CacheService.getScriptCache();
    var ck = ckMensagensPrivadas(idConversa);

    // Delta poll (apenas mensagens novas)
    if (aPartirDe > 0) {
      Logger.log('Delta poll: aPartirDe=' + aPartirDe);
      var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
      if (!aba) {
        Logger.log('Aba de mensagens privadas não encontrada');
        return JSON.stringify({ ok:true, mensagens:[] });
      }

      // Otimização: ler apenas as últimas 200 linhas em vez da planilha inteira
      var total = aba.getLastRow();
      var maxLinhas = 200;
      var inicio = Math.max(1, total - maxLinhas);
      var numLinhas = total - inicio;
      
      if (numLinhas <= 0) return JSON.stringify({ ok:true, mensagens:[] });
      
      var dados = aba.getRange(inicio + 1, 1, numLinhas, 13).getValues();
      Logger.log('Total de linhas lidas (otimizado): ' + numLinhas);
      var mensagens = [];

      for (var i = 1; i < dados.length; i++) {
        if (String(dados[i][0]) !== idConversa) continue;

        var ts = parseInt(dados[i][7]) || 0;
        Logger.log('Linha ' + i + ': idConversa=' + String(dados[i][0]) + ', ts=' + ts + ', aPartirDe=' + aPartirDe);
        if (ts > aPartirDe) {
          var nomeRemetente = String(dados[i][2]);
          // Buscar avatar do remetente usando cache de usuários (otimização)
          var avatarRemetente = '';
          try {
            var mapaUsuarios = obterMapaUsuarios();
            var usuario = mapaUsuarios[String(dados[i][1]).toLowerCase()];
            if (usuario && usuario.avatar) avatarRemetente = usuario.avatar;
          } catch(x){}
          
          mensagens.push({
            idConversa: String(dados[i][0]),
            emailRemetente: String(dados[i][1]),
            nomeRemetente: nomeRemetente,
            mensagem: String(dados[i][3]),
            data: String(dados[i][4]),
            hora: _formatarHora(dados[i][5]),
            idMensagem: String(dados[i][6]),
            ts: ts,
            status: String(dados[i][8]),
            reacoes: String(dados[i][9]),
            editada: String(dados[i][10]),
            textoOriginal: String(dados[i][11]),
            idRespondida: String(dados[i][12] || ''),
            avatar: avatarRemetente
          });
        }
      }

      Logger.log('Delta poll: ' + mensagens.length + ' mensagens encontradas');
      // Normalizar campos para compatibilidade com o frontend
      var historico = mensagens.map(function(m) {
        return {
          idMsg:        m.idMensagem,
          idUnico:      m.idMensagem,
          data:         m.data,
          hora:         m.hora,
          ts:           m.ts,
          remetente:    m.nomeRemetente,
          mensagem:     m.mensagem,
          textoOriginal:m.textoOriginal || m.mensagem,
          reacoes:      m.reacoes || '{}',
          editada:      m.editada || '',
          statusMsg:    m.status || 'ENVIADA',
          idRespondida: m.idRespondida || '',
          mencoes:      []
        };
      });
      return JSON.stringify({ ok:true, historico:historico, delta:true });
    }

    // Carga completa
    Logger.log('Carga completa');
    var cached = cache.get(ck);
    if (cached) {
      Logger.log('Retornando do cache');
      return cached;
    }

    Logger.log('Buscando aba: ' + ABA_MENSAGENS_PRIVADAS);
    var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (!aba) return JSON.stringify({ ok:true, mensagens:[] });
    
    var dados = aba.getDataRange().getValues();
    var mensagens = [];
    
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) === idConversa) {
        var nomeRemetente = String(dados[i][2]);
        var emailRemetente = String(dados[i][1]);
        // Buscar avatar do remetente
        var avatarRemetente = '';
        try {
          var usuarios = JSON.parse(listarTodosUsuarios());
          var usuario = usuarios.filter(function(u){ return u.email.toLowerCase() === emailRemetente.toLowerCase(); })[0];
          if (usuario && usuario.avatar) avatarRemetente = usuario.avatar;
        } catch(x){}
        
        mensagens.push({
          idConversa: String(dados[i][0]),
          emailRemetente: emailRemetente,
          nomeRemetente: nomeRemetente,
          mensagem: String(dados[i][3]),
          data: String(dados[i][4]),
          hora: _formatarHora(dados[i][5]),
          idMensagem: String(dados[i][6]),
          ts: parseInt(dados[i][7]) || 0,
          status: String(dados[i][8]),
          reacoes: String(dados[i][9]),
          editada: String(dados[i][10]),
          textoOriginal: String(dados[i][11]),
          idRespondida: String(dados[i][12] || ''),
          avatar: avatarRemetente
        });
      }
    }
    
    // Ordenar por timestamp (mais antigas primeiro)
    mensagens.sort(function(a, b) { return a.ts - b.ts; });
    
    // Limitar a últimas 500 mensagens (aumentado para suportar respostas a mensagens antigas)
    if (mensagens.length > 500) {
      mensagens = mensagens.slice(-500);
    }
    
    // Normalizar campos para compatibilidade com o frontend
    var historico = mensagens.map(function(m) {
      return {
        idMsg:        m.idMensagem,
        idUnico:      m.idMensagem,
        data:         m.data,
        hora:         m.hora,
        ts:           m.ts,
        remetente:    m.nomeRemetente,
        mensagem:     m.mensagem,
        textoOriginal:m.textoOriginal || m.mensagem,
        reacoes:      m.reacoes || '{}',
        editada:      m.editada || '',
        statusMsg:    m.status || 'ENVIADA',
        idRespondida: m.idRespondida || '',
        mencoes:      []
      };
    });
    
    var resultado = JSON.stringify({ ok:true, historico:historico, mensagens:mensagens, delta:false });
    _cachePutSafe(cache, ck, resultado, 30); // Cache 30 segundos
    return resultado;
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Marcar mensagens privadas como lidas ───────────────────
function marcarLidasPrivadas(idConversa, emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em || !idConversa) return JSON.stringify({ ok:false });
  
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (!aba) return JSON.stringify({ ok:false });
    
    var dados = aba.getDataRange().getValues();
    var linhasAtualizar = [];
    
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) !== idConversa) continue;
      if (String(dados[i][1]) === em) continue; // Não marcar próprias mensagens
      
      var status = String(dados[i][8]||'ENVIADA');
      if (status === 'ENVIADA' || status === 'ENTREGUE') {
        linhasAtualizar.push({ linha:i+1, novoStatus:'LIDA' });
      }
    }
    
    linhasAtualizar.forEach(function(item) {
      aba.getRange(item.linha, 9).setValue(item.novoStatus);
    });
    
    if (linhasAtualizar.length > 0) {
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckMensagensPrivadas(idConversa));
    }
    
    return JSON.stringify({ ok:true, marcadas:linhasAtualizar.length });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Apagar mensagem privada ───────────────────────────────
function apagarMensagemPrivada(idMensagem, emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em || !idMensagem) return JSON.stringify({ ok:false, erro:'Parâmetros inválidos.' });
  
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(6000);
    var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada.' });
    
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][6]) === idMensagem) {
        if (String(dados[i][1]) !== em) {
          return JSON.stringify({ ok:false, erro:'Só pode apagar suas próprias mensagens.' });
        }
        
        var ts = parseInt(dados[i][7]) || 0;
        var minutos = (Date.now() - ts) / 60000;
        if (minutos > MINUTOS_APAGAR_MSG) {
          return JSON.stringify({ ok:false, erro:'Prazo de ' + MINUTOS_APAGAR_MSG + ' min expirou.' });
        }
        
        aba.getRange(i+1, 9).setValue('APAGADA');          // col 9 = Status
        aba.getRange(i+1, 4).setValue('🗑️ Mensagem apagada.'); // col 4 = Mensagem
        SpreadsheetApp.flush();
        
        var idConv = String(dados[i][0]);
        CacheService.getScriptCache().remove(ckMensagensPrivadas(idConv));
        
        return JSON.stringify({ ok:true });
      }
    }
    
    return JSON.stringify({ ok:false, erro:'Mensagem não encontrada.' });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Helpers privados mensagens privadas ───────────────────────

function _garantirAbaConversasPrivadas() {
  var aba = obterAbaPorNome(ABA_CONVERSAS_PRIVADAS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_CONVERSAS_PRIVADAS);
    var headers = ['IdConversa','Email1','Nome1','Email2','Nome2','DataCriacao','Status'];
    var larguras = [300,220,140,220,140,160,100];
    aplicarCabecalhoEAjustes(aba, headers, larguras);
    formatarLinhaCabecalho(aba, headers.length);
  }
  return aba;
}

function _garantirAbaMensagensPrivadas() {
  var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_MENSAGENS_PRIVADAS);
    var est = obterEstruturaAbas().MensagensPrivadas;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

// ── Enquetes/Polls ───────────────────────────────────────────
function _garantirAbaEnquetes() {
  var aba = obterAbaPorNome(ABA_ENQUETES);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_ENQUETES);
    var est = obterEstruturaAbas().Enquetes;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

function criarEnquete(idGrupo, criadorEmail, criadorNome, pergunta, opcoes, duracaoHoras) {
  try {
    var em = normalizarEmail(criadorEmail);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    // Verificar permissão: apenas admin ou moderador pode criar enquetes
    var isAdmin = verificarAdmin(em);
    var isModerador = verificarSeModerador(em);
    if (!isAdmin && !isModerador) {
      return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas administradores ou moderadores podem criar enquetes.' });
    }
    
    var perguntaLimpa = String(pergunta||'').trim();
    if (!perguntaLimpa) return JSON.stringify({ ok:false, erro:'Pergunta vazia.' });
    
    if (!opcoes || !Array.isArray(opcoes) || opcoes.length < 2) {
      return JSON.stringify({ ok:false, erro:'Mínimo de 2 opções necessárias.' });
    }
    
    var opcoesLimpas = opcoes.map(function(o){ return String(o||'').trim(); }).filter(Boolean);
    if (opcoesLimpas.length < 2) {
      return JSON.stringify({ ok:false, erro:'Mínimo de 2 opções válidas necessárias.' });
    }
    
    var trava = LockService.getScriptLock();
    try {
      trava.waitLock(6000);
      
      var aba = _garantirAbaEnquetes();
      var idEnquete = 'enq_' + Utilities.getUuid();
      var agora = new Date();
      var dataEncerramento = new Date(agora.getTime() + (parseInt(duracaoHoras) || 24) * 60 * 60 * 1000);
      
      var opcoesJSON = JSON.stringify(opcoesLimpas);
      var votosJSON = JSON.stringify({}); // { "opcao1": ["email1", "email2"], "opcao2": ["email3"] }
      
      aba.appendRow([
        idEnquete,
        String(idGrupo || ''),
        em,
        String(criadorNome || ''),
        perguntaLimpa,
        opcoesJSON,
        votosJSON,
        'ATIVA',
        Utilities.formatDate(agora, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
        Utilities.formatDate(dataEncerramento, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss')
      ]);
      
      SpreadsheetApp.flush();
      
      return JSON.stringify({ ok:true, idEnquete:idEnquete });
    } finally {
      trava.releaseLock();
    }
  } catch(e) {
    Logger.log('Erro em criarEnquete: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function votarEnquete(idEnquete, opcao, emailVotante, nomeVotante) {
  try {
    var em = normalizarEmail(emailVotante);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
    
    var opcaoLimpa = String(opcao||'').trim();
    if (!opcaoLimpa) return JSON.stringify({ ok:false, erro:'Opção vazia.' });
    
    var trava = LockService.getScriptLock();
    try {
      trava.waitLock(6000);
      
      var aba = _garantirAbaEnquetes();
      var dados = aba.getDataRange().getValues();
      
      for (var i = 1; i < dados.length; i++) {
        if (String(dados[i][0]) === idEnquete) {
          var status = String(dados[i][7]);
          if (status !== 'ATIVA') {
            return JSON.stringify({ ok:false, erro:'Enquete não está ativa.' });
          }
          
          var votosJSON = String(dados[i][6]);
          var votos = votosJSON ? JSON.parse(votosJSON) : {};
          
          // Remover voto anterior do usuário (se existir)
          for (var op in votos) {
            if (votos[op] && Array.isArray(votos[op])) {
              votos[op] = votos[op].filter(function(e){ return e.toLowerCase() !== em; });
            }
          }
          
          // Adicionar novo voto
          if (!votos[opcaoLimpa]) votos[opcaoLimpa] = [];
          votos[opcaoLimpa].push(em);
          
          // Atualizar na planilha
          aba.getRange(i + 1, 7).setValue(JSON.stringify(votos));
          SpreadsheetApp.flush();
          
          return JSON.stringify({ ok:true });
        }
      }
      
      return JSON.stringify({ ok:false, erro:'Enquete não encontrada.' });
    } finally {
      trava.releaseLock();
    }
  } catch(e) {
    Logger.log('Erro em votarEnquete: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarEnquetesGrupo(idGrupo) {
  try {
    var aba = obterAbaPorNome(ABA_ENQUETES);
    if (!aba) return JSON.stringify({ ok:true, enquetes:[] });
    
    var dados = aba.getDataRange().getValues();
    var enquetes = [];
    
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][1]) === String(idGrupo)) {
        var votosJSON = String(dados[i][6]);
        var votos = votosJSON ? JSON.parse(votosJSON) : {};
        
        // Contar votos por opção
        var contagem = {};
        var totalVotos = 0;
        for (var op in votos) {
          if (votos[op] && Array.isArray(votos[op])) {
            contagem[op] = votos[op].length;
            totalVotos += votos[op].length;
          }
        }
        
        enquetes.push({
          idEnquete: String(dados[i][0]),
          idGrupo: String(dados[i][1]),
          criadorEmail: String(dados[i][2]),
          criadorNome: String(dados[i][3]),
          pergunta: String(dados[i][4]),
          opcoes: JSON.parse(String(dados[i][5])),
          votos: votos,
          contagem: contagem,
          totalVotos: totalVotos,
          status: String(dados[i][7]),
          dataCriacao: String(dados[i][8]),
          dataEncerramento: String(dados[i][9])
        });
      }
    }
    
    return JSON.stringify({ ok:true, enquetes:enquetes });
  } catch(e) {
    Logger.log('Erro em listarEnquetesGrupo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message, enquetes:[] });
  }
}

function encerrarEnquete(idEnquete, emailSolicitante) {
  try {
    var em = normalizarEmail(emailSolicitante);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
    
    var trava = LockService.getScriptLock();
    try {
      trava.waitLock(6000);
      
      var aba = _garantirAbaEnquetes();
      var dados = aba.getDataRange().getValues();
      
      for (var i = 1; i < dados.length; i++) {
        if (String(dados[i][0]) === idEnquete) {
          var criadorEmail = String(dados[i][2]);
          
          // Verificar se é o criador ou admin
          var isAdmin = JSON.parse(verificarAdmin(em));
          if (criadorEmail.toLowerCase() !== em && !isAdmin.admin) {
            return JSON.stringify({ ok:false, erro:'Apenas o criador ou admin pode encerrar.' });
          }
          
          // Encerrar enquete
          aba.getRange(i + 1, 7).setValue('ENCERRADA');
          SpreadsheetApp.flush();
          
          return JSON.stringify({ ok:true });
        }
      }
      
      return JSON.stringify({ ok:false, erro:'Enquete não encontrada.' });
    } finally {
      trava.releaseLock();
    }
  } catch(e) {
    Logger.log('Erro em encerrarEnquete: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Sistema de Busca Avançada ───────────────────────────────────
function _garantirAbaBuscas() {
  var aba = obterAbaPorNome(ABA_BUSCAS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_BUSCAS);
    var est = obterEstruturaAbas().Buscas;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

function buscarMensagensAvancada(termo, filtros, emailUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var termoLimpo = String(termo||'').trim().toLowerCase();
    if (!termoLimpo) return JSON.stringify({ ok:false, erro:'Termo de busca vazio.' });

    var filtrosObj = filtros ? JSON.parse(filtros) : {};
    var idGrupo = filtrosObj.idGrupo || '';
    var autor = filtrosObj.autor || '';
    var dataInicio = filtrosObj.dataInicio || '';
    var dataFim = filtrosObj.dataFim || '';
    var tipoBusca = filtrosObj.tipoBusca || 'texto'; // texto, autor, data

    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba de mensagens não encontrada.' });

    var dados = aba.getDataRange().getValues();
    var resultados = [];

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var mensagem = String(linha[4]||'').toLowerCase();
      var remetente = String(linha[2]||'').toLowerCase();
      var destinatario = String(linha[3]||'');
      var dataMsg = linha[0];
      var horaMsg = linha[1];
      var idMsg = String(linha[6]||'');
      var reacoes = String(linha[7]||'');
      var editada = String(linha[8]||'');
      var statusMsg = String(linha[9]||'');
      var idRespondida = String(linha[10]||'');
      var textoOriginal = String(linha[11]||'');

      // Verificar permissão de acesso ao grupo
      if (destinatario && !_verificarAcessoGrupo(destinatario, em, '')) continue;

      // Aplicar filtros
      var match = false;

      if (tipoBusca === 'texto') {
        match = mensagem.indexOf(termoLimpo) !== -1 || textoOriginal.toLowerCase().indexOf(termoLimpo) !== -1;
      } else if (tipoBusca === 'autor') {
        match = remetente.indexOf(termoLimpo) !== -1;
      } else if (tipoBusca === 'data') {
        match = true; // Data é filtrada separadamente
      }

      if (!match) continue;

      // Filtro por grupo
      if (idGrupo && destinatario !== idGrupo) continue;

      // Filtro por autor
      if (autor && remetente !== autor.toLowerCase()) continue;

      // Filtro por data
      if (dataInicio || dataFim) {
        var dataCompleta = dataMsg + ' ' + horaMsg;
        var tsMsg = new Date(dataCompleta).getTime();
        if (dataInicio) {
          var tsInicio = new Date(dataInicio).getTime();
          if (tsMsg < tsInicio) continue;
        }
        if (dataFim) {
          var tsFim = new Date(dataFim + ' 23:59:59').getTime();
          if (tsMsg > tsFim) continue;
        }
      }

      resultados.push({
        idMsg: idMsg,
        data: dataMsg,
        hora: horaMsg,
        remetente: linha[2],
        destinatario: destinatario,
        mensagem: linha[4],
        textoOriginal: textoOriginal,
        reacoes: reacoes,
        editada: editada,
        statusMsg: statusMsg,
        idRespondida: idRespondida
      });
    }

    // Limitar a 100 resultados
    if (resultados.length > 100) resultados = resultados.slice(0, 100);

    // Salvar busca no histórico
    var abaBuscas = _garantirAbaBuscas();
    var idBusca = Utilities.getUuid();
    var now = new Date();
    abaBuscas.appendRow([
      idBusca,
      em,
      tipoBusca,
      termoLimpo,
      JSON.stringify(filtrosObj),
      JSON.stringify(resultados),
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss')
    ]);

    return JSON.stringify({ ok:true, resultados: resultados, total: resultados.length });
  } catch(e) {
    Logger.log('Erro em buscarMensagensAvancada: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function buscarMensagensPrivadasAvancada(termo, filtros, emailUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var termoLimpo = String(termo||'').trim().toLowerCase();
    if (!termoLimpo) return JSON.stringify({ ok:false, erro:'Termo de busca vazio.' });

    var filtrosObj = filtros ? JSON.parse(filtros) : {};
    var idConversa = filtrosObj.idConversa || '';
    var autor = filtrosObj.autor || '';
    var dataInicio = filtrosObj.dataInicio || '';
    var dataFim = filtrosObj.dataFim || '';

    var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba de mensagens privadas não encontrada.' });

    var dados = aba.getDataRange().getValues();
    var resultados = [];

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var idConvLinha = String(linha[0]||'');
      var emailRemetente = String(linha[1]||'').toLowerCase();
      var nomeRemetente = String(linha[2]||'').toLowerCase();
      var mensagem = String(linha[3]||'').toLowerCase();
      var dataMsg = linha[4];
      var horaMsg = linha[5];
      var idMsg = String(linha[6]||'');
      var textoOriginal = String(linha[11]||'');

      // Verificar se o usuário tem acesso à conversa
      if (emailRemetente !== em.toLowerCase() && idConvLinha.indexOf(em.toLowerCase()) === -1) continue;

      // Aplicar filtros
      var match = mensagem.indexOf(termoLimpo) !== -1 || textoOriginal.toLowerCase().indexOf(termoLimpo) !== -1;
      if (!match) continue;

      // Filtro por conversa
      if (idConversa && idConvLinha !== idConversa) continue;

      // Filtro por autor
      if (autor && nomeRemetente !== autor.toLowerCase() && emailRemetente !== autor.toLowerCase()) continue;

      // Filtro por data
      if (dataInicio || dataFim) {
        var dataCompleta = dataMsg + ' ' + horaMsg;
        var tsMsg = new Date(dataCompleta).getTime();
        if (dataInicio) {
          var tsInicio = new Date(dataInicio).getTime();
          if (tsMsg < tsInicio) continue;
        }
        if (dataFim) {
          var tsFim = new Date(dataFim + ' 23:59:59').getTime();
          if (tsMsg > tsFim) continue;
        }
      }

      resultados.push({
        idMsg: idMsg,
        data: dataMsg,
        hora: horaMsg,
        remetente: linha[2],
        emailRemetente: emailRemetente,
        idConversa: idConvLinha,
        mensagem: linha[3],
        textoOriginal: textoOriginal
      });
    }

    // Limitar a 100 resultados
    if (resultados.length > 100) resultados = resultados.slice(0, 100);

    return JSON.stringify({ ok:true, resultados: resultados, total: resultados.length });
  } catch(e) {
    Logger.log('Erro em buscarMensagensPrivadasAvancada: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}
// ── Sistema de Comandos de Chat ───────────────────────────────
function _garantirAbaComandos() {
  var aba = obterAbaPorNome(ABA_COMANDOS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_COMANDOS);
    var est = obterEstruturaAbas().Comandos;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

function processarComandoChat(mensagem, idGrupo, emailUsuario, nomeUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var msgLimpa = String(mensagem||'').trim();
    if (msgLimpa.indexOf('/') !== 0) return JSON.stringify({ ok:false, comando:null }); // Não é um comando

    var partes = msgLimpa.split(' ');
    var comando = partes[0].toLowerCase();
    var parametros = partes.slice(1).join(' ');

    var abaComandos = _garantirAbaComandos();
    var idComando = Utilities.getUuid();
    var now = new Date();
    var resultado = '';

    // Verificar permissões
    var isAdmin = verificarAdmin(em);
    var isModerador = verificarSeModerador(em);

    switch(comando) {
      case '/ban':
        if (!isAdmin && !isModerador) {
          resultado = 'Erro: Permissão negada. Apenas moderadores podem usar este comando.';
        } else if (!parametros) {
          resultado = 'Uso: /ban <email_do_usuario>';
        } else {
          var emailBan = normalizarEmail(parametros);
          if (!emailBan) {
            resultado = 'Erro: Email inválido.';
          } else {
            var banResult = bloquearUsuario(emailBan, em, 'Banido via comando /ban por '+nomeUsuario);
            resultado = JSON.parse(banResult).ok ? 'Usuário '+emailBan+' banido com sucesso.' : 'Erro ao banir usuário.';
          }
        }
        break;

      case '/mute':
        if (!isAdmin && !isModerador) {
          resultado = 'Erro: Permissão negada. Apenas moderadores podem usar este comando.';
        } else if (!parametros) {
          resultado = 'Uso: /mute <email_do_usuario>';
        } else {
          var emailMute = normalizarEmail(parametros);
          if (!emailMute) {
            resultado = 'Erro: Email inválido.';
          } else {
            // Implementar mute (similar a ban mas temporário)
            resultado = 'Comando /mute ainda não implementado completamente.';
          }
        }
        break;

      case '/kick':
        if (!isAdmin && !isModerador) {
          resultado = 'Erro: Permissão negada. Apenas moderadores podem usar este comando.';
        } else if (!parametros) {
          resultado = 'Uso: /kick <email_do_usuario>';
        } else {
          var emailKick = normalizarEmail(parametros);
          if (!emailKick) {
            resultado = 'Erro: Email inválido.';
          } else {
            // Implementar kick (remover do grupo)
            resultado = 'Comando /kick ainda não implementado completamente.';
          }
        }
        break;

      case '/info':
        if (!parametros) {
          resultado = 'Uso: /info <email_do_usuario>';
        } else {
          var emailInfo = normalizarEmail(parametros);
          if (!emailInfo) {
            resultado = 'Erro: Email inválido.';
          } else {
            var usuarios = JSON.parse(listarTodosUsuarios());
            var usuario = usuarios.filter(function(u){ return u.email.toLowerCase() === emailInfo.toLowerCase(); })[0];
            if (usuario) {
              resultado = 'Usuário: '+usuario.nome+' | Email: '+usuario.email+' | Status: '+usuario.status+' | Cadastro: '+usuario.dataCadastro;
            } else {
              resultado = 'Usuário não encontrado.';
            }
          }
        }
        break;

      case '/help':
        resultado = 'Comandos disponíveis: /ban, /mute, /kick, /info, /help';
        break;

      default:
        resultado = 'Comando desconhecido: '+comando+'. Use /help para ver os comandos disponíveis.';
    }

    // Registrar comando
    abaComandos.appendRow([
      idComando,
      idGrupo,
      comando,
      parametros,
      em,
      nomeUsuario,
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
      resultado
    ]);

    return JSON.stringify({ ok:true, comando:comando, resultado:resultado });
  } catch(e) {
    Logger.log('Erro em processarComandoChat: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function _garantirAbaAutomacao() {
  var aba = obterAbaPorNome(ABA_AUTOMACAO);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_AUTOMACAO);
    var est = obterEstruturaAbas().Automacao;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

// ── Sistema de Agendamento de Mensagens ───────────────────────
function _garantirAbaAgendamentos() {
  var aba = obterAbaPorNome(ABA_AGENDAMENTOS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_AGENDAMENTOS);
    var est = obterEstruturaAbas().Agendamentos;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

function agendarMensagem(emailUsuario, nomeUsuario, destino, mensagem, dataAgendamento, horaAgendamento) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var msgLimpa = String(mensagem||'').trim();
    if (!msgLimpa) return JSON.stringify({ ok:false, erro:'Mensagem vazia.' });
    if (msgLimpa.length > MAX_TAMANHO_MSG) return JSON.stringify({ ok:false, erro:'Mensagem muito longa.' });

    var dataAg = String(dataAgendamento||'').trim();
    var horaAg = String(horaAgendamento||'').trim();
    if (!dataAg || !horaAg) return JSON.stringify({ ok:false, erro:'Data e hora do agendamento são obrigatórias.' });

    // Validar formato da data e hora
    var dataHoraCompleta = dataAg + ' ' + horaAg;
    var tsAgendamento = new Date(dataHoraCompleta).getTime();
    if (isNaN(tsAgendamento)) return JSON.stringify({ ok:false, erro:'Data ou hora inválida.' });

    var agora = Date.now();
    if (tsAgendamento <= agora) return JSON.stringify({ ok:false, erro:'Data de agendamento deve ser no futuro.' });

    var aba = _garantirAbaAgendamentos();
    var idAgendamento = Utilities.getUuid();
    var now = new Date();

    aba.appendRow([
      idAgendamento,
      em,
      nomeUsuario,
      destino,
      msgLimpa,
      dataAg,
      horaAg,
      'PENDENTE',
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss')
    ]);

    return JSON.stringify({ ok:true, idAgendamento: idAgendamento });
  } catch(e) {
    Logger.log('Erro em agendarMensagem: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function processarAgendamentosPendentes() {
  try {
    var aba = obterAbaPorNome(ABA_AGENDAMENTOS);
    if (!aba) return JSON.stringify({ ok:true, processados: 0 });

    var dados = aba.getDataRange().getValues();
    var agora = Date.now();
    var processados = 0;

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var status = String(linha[7]||'');
      
      if (status !== 'PENDENTE') continue;

      var dataAg = String(linha[5]||'');
      var horaAg = String(linha[6]||'');
      var dataHoraCompleta = dataAg + ' ' + horaAg;
      var tsAgendamento = new Date(dataHoraCompleta).getTime();

      if (tsAgendamento <= agora) {
        // Enviar a mensagem
        var emailCriador = linha[1];
        var nomeCriador = linha[2];
        var destino = linha[3];
        var mensagem = linha[4];

        var resultado = salvarMensagem(nomeCriador, mensagem, destino, emailCriador, '');
        
        // Atualizar status
        aba.getRange(i+1, 8).setValue('ENVIADO');
        processados++;
      }
    }

    return JSON.stringify({ ok:true, processados: processados });
  } catch(e) {
    Logger.log('Erro em processarAgendamentosPendentes: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarAgendamentosUsuario(emailUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var aba = obterAbaPorNome(ABA_AGENDAMENTOS);
    if (!aba) return JSON.stringify({ ok:true, agendamentos:[] });

    var dados = aba.getDataRange().getValues();
    var agendamentos = [];

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var emailCriador = String(linha[1]||'');

      if (emailCriador.toLowerCase() !== em.toLowerCase()) continue;

      agendamentos.push({
        idAgendamento: String(linha[0]),
        emailCriador: emailCriador,
        nomeCriador: String(linha[2]),
        destino: String(linha[3]),
        mensagem: String(linha[4]),
        dataAgendamento: String(linha[5]),
        horaAgendamento: String(linha[6]),
        status: String(linha[7]),
        dataCriacao: String(linha[8])
      });
    }

    return JSON.stringify({ ok:true, agendamentos: agendamentos });
  } catch(e) {
    Logger.log('Erro em listarAgendamentosUsuario: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function cancelarAgendamento(idAgendamento, emailUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var aba = obterAbaPorNome(ABA_AGENDAMENTOS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba de agendamentos não encontrada.' });

    var dados = aba.getDataRange().getValues();
    var encontrado = false;

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var id = String(linha[0]||'');
      var emailCriador = String(linha[1]||'');

      if (id === idAgendamento) {
        if (emailCriador.toLowerCase() !== em.toLowerCase()) {
          return JSON.stringify({ ok:false, erro:'Permissão negada. Você só pode cancelar seus próprios agendamentos.' });
        }

        var status = String(linha[7]||'');
        if (status === 'ENVIADO') {
          return JSON.stringify({ ok:false, erro:'Agendamento já foi enviado e não pode ser cancelado.' });
        }

        aba.deleteRow(i+1);
        encontrado = true;
        break;
      }
    }

    if (!encontrado) return JSON.stringify({ ok:false, erro:'Agendamento não encontrado.' });

    return JSON.stringify({ ok:true });
  } catch(e) {
    Logger.log('Erro em cancelarAgendamento: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Sistema de Relatórios de Abuso ───────────────────────────
function _garantirAbaReports() {
  var aba = obterAbaPorNome(ABA_REPORTS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_REPORTS);
    var est = obterEstruturaAbas().Reports;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

function criarReportAbuso(emailReporter, nomeReporter, tipoReport, idMensagem, idUsuarioReportado, motivo) {
  try {
    var em = normalizarEmail(emailReporter);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var motivoLimpo = String(motivo||'').trim();
    if (!motivoLimpo) return JSON.stringify({ ok:false, erro:'Motivo é obrigatório.' });

    var tipo = String(tipoReport||'').trim();
    if (!tipo) return JSON.stringify({ ok:false, erro:'Tipo de report é obrigatório.' });

    var aba = _garantirAbaReports();
    var idReport = Utilities.getUuid();
    var now = new Date();

    aba.appendRow([
      idReport,
      em,
      nomeReporter,
      tipo,
      String(idMensagem||''),
      String(idUsuarioReportado||''),
      motivoLimpo,
      'PENDENTE',
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
      '',
      ''
    ]);

    return JSON.stringify({ ok:true, idReport: idReport });
  } catch(e) {
    Logger.log('Erro em criarReportAbuso: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarReportsPendentes() {
  try {
    var aba = obterAbaPorNome(ABA_REPORTS);
    if (!aba) return JSON.stringify({ ok:true, reports:[] });

    var dados = aba.getDataRange().getValues();
    var reports = [];

    // Buscar todas as mensagens de grupo para referência
    var abaMsg = obterAbaPorNome(ABA_MENSAGENS);
    var mapaMensagens = {};
    if (abaMsg) {
      var dadosMsg = abaMsg.getDataRange().getValues();
      for (var i = 1; i < dadosMsg.length; i++) {
        var linhaMsg = dadosMsg[i];
        var idMsg = String(linhaMsg[6]||'');
        if (idMsg) {
          mapaMensagens[idMsg] = {
            data: String(linhaMsg[0]),
            hora: _formatarHora(linhaMsg[1]),
            remetente: String(linhaMsg[2]),
            destinatario: String(linhaMsg[3]),
            mensagem: String(linhaMsg[4]),
            textoOriginal: String(linhaMsg[11]||''),
            statusMsg: String(linhaMsg[9]||''),
            editada: String(linhaMsg[8]||'Não'),
            tipo: 'grupo'
          };
        }
      }
    }

    // Buscar também mensagens privadas
    var abaMsgPriv = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (abaMsgPriv) {
      var dadosMsgPriv = abaMsgPriv.getDataRange().getValues();
      for (var i = 1; i < dadosMsgPriv.length; i++) {
        var linhaMsgPriv = dadosMsgPriv[i];
        var idMsgPriv = String(linhaMsgPriv[6]||'');
        if (idMsgPriv && !mapaMensagens[idMsgPriv]) {
          mapaMensagens[idMsgPriv] = {
            data: String(linhaMsgPriv[4]),
            hora: _formatarHora(linhaMsgPriv[5]),
            remetente: String(linhaMsgPriv[2]),
            destinatario: 'Conversa Privada',
            mensagem: String(linhaMsgPriv[3]),
            textoOriginal: String(linhaMsgPriv[11]||''),
            statusMsg: String(linhaMsgPriv[8]||''),
            editada: String(linhaMsgPriv[10]||'Não'),
            tipo: 'privado'
          };
        }
      }
    }

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var status = String(linha[7]||'');

      if (status !== 'PENDENTE') continue;

      var idMensagem = String(linha[4]||'');
      var msgOriginal = mapaMensagens[idMensagem] || null;

      reports.push({
        idReport: String(linha[0]),
        emailReporter: String(linha[1]),
        nomeReporter: String(linha[2]),
        tipoReport: String(linha[3]),
        idMensagem: idMensagem,
        idUsuarioReportado: String(linha[5]),
        motivo: String(linha[6]),
        status: status,
        dataReport: _formatarDataHora(linha[8]),
        mensagemOriginal: msgOriginal
      });
    }

    return JSON.stringify({ ok:true, reports: reports });
  } catch(e) {
    Logger.log('Erro em listarReportsPendentes: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarReportsResolvidos() {
  try {
    var aba = obterAbaPorNome(ABA_REPORTS);
    if (!aba) return JSON.stringify({ ok:true, reports:[] });

    var dados = aba.getDataRange().getValues();
    var reports = [];

    // Buscar todas as mensagens de grupo para referência
    var abaMsg = obterAbaPorNome(ABA_MENSAGENS);
    var mapaMensagens = {};
    if (abaMsg) {
      var dadosMsg = abaMsg.getDataRange().getValues();
      for (var i = 1; i < dadosMsg.length; i++) {
        var linhaMsg = dadosMsg[i];
        var idMsg = String(linhaMsg[6]||'');
        if (idMsg) {
          mapaMensagens[idMsg] = {
            data: String(linhaMsg[0]),
            hora: _formatarHora(linhaMsg[1]),
            remetente: String(linhaMsg[2]),
            destinatario: String(linhaMsg[3]),
            mensagem: String(linhaMsg[4]),
            textoOriginal: String(linhaMsg[11]||''),
            statusMsg: String(linhaMsg[9]||''),
            editada: String(linhaMsg[8]||'Não'),
            tipo: 'grupo'
          };
        }
      }
    }

    // Buscar também mensagens privadas
    var abaMsgPriv = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (abaMsgPriv) {
      var dadosMsgPriv = abaMsgPriv.getDataRange().getValues();
      for (var i = 1; i < dadosMsgPriv.length; i++) {
        var linhaMsgPriv = dadosMsgPriv[i];
        var idMsgPriv = String(linhaMsgPriv[6]||'');
        if (idMsgPriv && !mapaMensagens[idMsgPriv]) {
          mapaMensagens[idMsgPriv] = {
            data: String(linhaMsgPriv[4]),
            hora: _formatarHora(linhaMsgPriv[5]),
            remetente: String(linhaMsgPriv[2]),
            destinatario: 'Conversa Privada',
            mensagem: String(linhaMsgPriv[3]),
            textoOriginal: String(linhaMsgPriv[11]||''),
            statusMsg: String(linhaMsgPriv[8]||''),
            editada: String(linhaMsgPriv[10]||'Não'),
            tipo: 'privado'
          };
        }
      }
    }

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var status = String(linha[7]||'');

      if (status !== 'RESOLVIDO' && status !== 'IGNORADO') continue;

      var idMensagem = String(linha[4]||'');
      var msgOriginal = mapaMensagens[idMensagem] || null;

      reports.push({
        idReport: String(linha[0]),
        emailReporter: String(linha[1]),
        nomeReporter: String(linha[2]),
        tipoReport: String(linha[3]),
        idMensagem: idMensagem,
        idUsuarioReportado: String(linha[5]),
        motivo: String(linha[6]),
        status: status,
        dataReport: _formatarDataHora(linha[8]),
        dataResolucao: _formatarDataHora(linha[9]||''),
        resolvidoPor: String(linha[10]||''),
        acaoTomada: String(linha[11]||''),
        mensagemOriginal: msgOriginal,
        _dataResolucaoRaw: linha[9] // Para ordenação
      });
    }

    // Ordenar por data de resolução (mais recentes primeiro)
    reports.sort(function(a, b) {
      var tsA = new Date(a._dataResolucaoRaw || 0).getTime() || 0;
      var tsB = new Date(b._dataResolucaoRaw || 0).getTime() || 0;
      return tsB - tsA;
    });

    return JSON.stringify({ ok:true, reports: reports });
  } catch(e) {
    Logger.log('Erro em listarReportsResolvidos: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function resolverReport(idReport, emailModerador, acao, acaoTomada) {
  try {
    var em = normalizarEmail(emailModerador);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var isModerador = verificarSeModerador(em);
    var isAdmin = verificarAdmin(em);

    if (!isModerador && !isAdmin) {
      return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas moderadores ou administradores podem resolver reports.' });
    }

    var aba = obterAbaPorNome(ABA_REPORTS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba de reports não encontrada.' });

    var dados = aba.getDataRange().getValues();
    var encontrado = false;
    var usuarioReportado = '';

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var id = String(linha[0]||'');

      if (id === idReport) {
        var status = String(linha[7]||'');
        if (status !== 'PENDENTE') {
          return JSON.stringify({ ok:false, erro:'Report já foi resolvido.' });
        }

        usuarioReportado = String(linha[5]||'');

        // Verificar se o usuário reportado é moderador
        var isReportadoModerador = verificarSeModerador(usuarioReportado);

        // Se o reportado é moderador, apenas admin pode resolver
        if (isReportadoModerador && !isAdmin) {
          return JSON.stringify({ ok:false, erro:'Permissão negada. Reports sobre moderadores só podem ser resolvidos por administradores.' });
        }

        var now = new Date();
        
        // Se a ação for ignorar, mudar status para IGNORADO
        if (acao === 'ignorar') {
          aba.getRange(i+1, 8).setValue('IGNORADO');
          aba.getRange(i+1, 9).setValue(Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'));
          aba.getRange(i+1, 10).setValue(em);
          aba.getRange(i+1, 11).setValue('Report ignorado sem ação');
        } else {
          // Se for resolver, requer ação tomada
          if (!acaoTomada || String(acaoTomada).trim() === '') {
            return JSON.stringify({ ok:false, erro:'É obrigatório descrever a ação tomada para resolver o report.' });
          }
          aba.getRange(i+1, 8).setValue('RESOLVIDO');
          aba.getRange(i+1, 9).setValue(Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'));
          aba.getRange(i+1, 10).setValue(em);
          aba.getRange(i+1, 11).setValue(String(acaoTomada).trim());
        }
        
        encontrado = true;
        break;
      }
    }

    if (!encontrado) return JSON.stringify({ ok:false, erro:'Report não encontrado.' });

    return JSON.stringify({ ok:true });
  } catch(e) {
    Logger.log('Erro em resolverReport: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Resolver Report com Sistema de Punições ─────────────────────
function resolverReportComPunicao(idReport, emailModerador, dadosPunicaoJson) {
  try {
    var em = normalizarEmail(emailModerador);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var isModerador = verificarSeModerador(em);
    var isAdmin = verificarAdmin(em);

    if (!isModerador && !isAdmin) {
      return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas moderadores ou administradores podem resolver reports.' });
    }

    var dadosPunicao = JSON.parse(dadosPunicaoJson);
    
    var aba = obterAbaPorNome(ABA_REPORTS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba de reports não encontrada.' });

    var dados = aba.getDataRange().getValues();
    var encontrado = false;
    var usuarioReportado = '';
    var emailDenunciante = '';
    var idGrupoReport = '';

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var id = String(linha[0]||'');

      if (id === idReport) {
        var status = String(linha[7]||'');
        if (status !== 'PENDENTE') {
          return JSON.stringify({ ok:false, erro:'Report já foi resolvido.' });
        }

        usuarioReportado = String(linha[5]||'');
        emailDenunciante = String(linha[1]||'');
        idGrupoReport = String(linha[2]||'');

        // Buscar email do usuário reportado (denunciado)
        var emailReportado = _obterEmailPorNome(usuarioReportado);
        if (!emailReportado) {
          // Tentar buscar diretamente na aba de usuários
          emailReportado = usuarioReportado; // Fallback - assume que já é email
        }

        var isReportadoModerador = verificarSeModerador(emailReportado || usuarioReportado);

        if (isReportadoModerador && !isAdmin) {
          return JSON.stringify({ ok:false, erro:'Permissão negada. Reports sobre moderadores só podem ser resolvidos por administradores.' });
        }

        var now = new Date();
        var acaoTomada = dadosPunicao.observacoes || '';
        
        // Determinar quem será punido
        var emailParaPunir = '';
        var tipoDecisao = dadosPunicao.decisao || 'aprovado';
        
        if (tipoDecisao === 'reverso') {
          emailParaPunir = emailDenunciante;
          acaoTomada = '[REVERSO] ' + acaoTomada + ' - Denunciante punido por report falso.';
        } else {
          emailParaPunir = emailReportado || usuarioReportado;
        }
        
        // Aplicar punição se necessário
        var resultadoPunicao = '';
        if (dadosPunicao.tipoPunicao && dadosPunicao.tipoPunicao !== 'nenhuma') {
          var detalhesReport = {
            idReport: idReport,
            emailDenunciante: emailDenunciante,
            nomeDenunciante: String(linha[2]||''),
            motivo: String(linha[6]||''),
            tipoReport: String(linha[3]||''),
            acaoTomada: acaoTomada
          };
          resultadoPunicao = aplicarPunicao(emailParaPunir, dadosPunicao.tipoPunicao, dadosPunicao.quantidade, dadosPunicao.unidade, em, dadosPunicao.advertencias || [], idReport, detalhesReport);
          if (resultadoPunicao.indexOf('Erro') !== -1) {
            return JSON.stringify({ ok:false, erro:resultadoPunicao });
          }
        }
        
        // Atualizar report
        aba.getRange(i+1, 8).setValue('RESOLVIDO');
        aba.getRange(i+1, 9).setValue(Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'));
        aba.getRange(i+1, 10).setValue(em);
        aba.getRange(i+1, 11).setValue(acaoTomada + (resultadoPunicao ? ' | ' + resultadoPunicao : ''));
        
        encontrado = true;
        break;
      }
    }

    if (!encontrado) return JSON.stringify({ ok:false, erro:'Report não encontrado.' });

    return JSON.stringify({ ok:true });
  } catch(e) {
    Logger.log('Erro em resolverReportComPunicao: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Aplicar Punição (Mute, Ban Temporário, Ban Permanente) ─────
function aplicarPunicao(emailUsuario, tipoPunicao, quantidade, unidade, emailModerador, advertencias, idReport, detalhesReport) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return 'Erro: Email inválido.';
    
    var abaPunicoes = _garantirAbaPunicoes();
    var idPunicao = Utilities.getUuid();
    var now = new Date();
    var tz = Session.getScriptTimeZone();
    
    // Buscar nome do moderador
    var nomeModerador = _obterNomeUsuario(emailModerador) || emailModerador;
    
    var dataInicio = Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm:ss');
    var dataFim = '';
    var status = 'ATIVA';
    
    // Calcular data de expiração para punições temporárias
    if (tipoPunicao === 'mute' || tipoPunicao === 'ban_temp') {
      var multiplicador = 1;
      if (unidade === 'horas') multiplicador = 60 * 60 * 1000;
      else if (unidade === 'dias') multiplicador = 24 * 60 * 60 * 1000;
      else if (unidade === 'semanas') multiplicador = 7 * 24 * 60 * 60 * 1000;
      else if (unidade === 'meses') multiplicador = 30 * 24 * 60 * 60 * 1000;
      
      var dataExpiracao = new Date(now.getTime() + (quantidade * multiplicador));
      dataFim = Utilities.formatDate(dataExpiracao, tz, 'dd/MM/yyyy HH:mm:ss');
    }
    
    // Adicionar punição na aba com detalhes do report
    abaPunicoes.appendRow([
      idPunicao,
      em,
      tipoPunicao.toUpperCase(),
      quantidade,
      unidade,
      dataInicio,
      dataFim,
      status,
      emailModerador,
      nomeModerador,
      Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm:ss'),
      advertencias.join(','),
      idReport || '',
      JSON.stringify(detalhesReport || {})
    ]);
    
    // Invalidar cache de bloqueios
    var cache = CacheService.getScriptCache();
    cache.remove('bloqueio_' + em.toLowerCase());
    cache.remove('punicao_' + em.toLowerCase());
    
    var descricao = tipoPunicao === 'mute' ? 'Mute' : (tipoPunicao === 'ban_temp' ? 'Ban Temporário' : 'Ban Permanente');
    if (tipoPunicao !== 'ban_perm') {
      descricao += ' de ' + quantidade + ' ' + unidade;
    }
    
    return descricao + ' aplicado com sucesso.';
  } catch(e) {
    Logger.log('Erro em aplicarPunicao: ' + e.message);
    return 'Erro ao aplicar punição: ' + e.message;
  }
}

// ── Garantir Aba de Punições ───────────────────────────────────
function _garantirAbaPunicoes() {
  Logger.log('_garantirAbaPunicoes: Iniciando');
  
  var aba = obterAbaPorNome(ABA_PUNICOES);
  if (!aba) {
    Logger.log('_garantirAbaPunicoes: Aba não existe, criando nova');
    var ss = obterPlanilhaChat();
    aba = ss.insertSheet(ABA_PUNICOES);
    aba.appendRow(['IdPunicao', 'EmailUsuario', 'TipoPunicao', 'Quantidade', 'Unidade', 'DataInicio', 'DataFim', 'Status', 'EmailModerador', 'NomeModerador', 'DataAplicacao', 'Advertencias', 'IdReport', 'DetalhesReport', 'ReajustadaPorApelacao']);
  } else {
    Logger.log('_garantirAbaPunicoes: Aba já existe, verificando estrutura');
    var dados = aba.getDataRange().getValues();
    if (dados.length > 0) {
      var headers = dados[0];
      var headersCorretos = ['IdPunicao', 'EmailUsuario', 'TipoPunicao', 'Quantidade', 'Unidade', 'DataInicio', 'DataFim', 'Status', 'EmailModerador', 'NomeModerador', 'DataAplicacao', 'Advertencias', 'IdReport', 'DetalhesReport', 'ReajustadaPorApelacao'];
      
      Logger.log('_garantirAbaPunicoes: Headers atuais: ' + headers.join(' | '));
      Logger.log('_garantirAbaPunicoes: Headers esperados: ' + headersCorretos.join(' | '));
      
      // Se headers não corresponderem, adicionar coluna ReajustadaPorApelacao
      if (headers.length < 15) {
        Logger.log('_garantirAbaPunicoes: Adicionando coluna ReajustadaPorApelacao');
        aba.getRange(1, 15).setValue('ReajustadaPorApelacao');
      } else if (headers[14] !== 'ReajustadaPorApelacao') {
        Logger.log('_garantirAbaPunicoes: Estrutura incorreta, recriando aba');
        var ss = obterPlanilhaChat();
        ss.deleteSheet(aba);
        aba = ss.insertSheet(ABA_PUNICOES);
        aba.appendRow(headersCorretos);
      } else {
        Logger.log('_garantirAbaPunicoes: Estrutura correta, mantendo aba');
      }
    }
  }
  
  Logger.log('_garantirAbaPunicoes: Finalizado');
  return aba;
}

// ── Verificar se usuário está punido (mute ou ban) ───────────────
function verificarPunicaoAtiva(emailUsuario) {
  Logger.log('=== verificarPunicaoAtiva INICIADO ===');
  Logger.log('Email recebido: ' + emailUsuario);
  
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) {
      Logger.log('Email inválido após normalização');
      return JSON.stringify({ ok:true, punicao:null });
    }
    
    Logger.log('Email normalizado: ' + em);
    
    var cache = CacheService.getScriptCache();
    var cacheKey = 'punicao_' + em.toLowerCase();
    
    // Tentar usar cache primeiro
    var cached = cache.get(cacheKey);
    if (cached) {
      Logger.log('Cache hit para: ' + cacheKey);
      return cached;
    }
    
    Logger.log('Cache miss, buscando na planilha');
    
    var abaPunicoes = obterAbaPorNome(ABA_PUNICOES);
    if (!abaPunicoes) {
      Logger.log('Aba de punições não encontrada - criando');
      abaPunicoes = _garantirAbaPunicoes();
      return JSON.stringify({ ok:true, punicao:null });
    }
    
    var dados = abaPunicoes.getDataRange().getValues();
    var now = new Date();
    var punicaoAtiva = null;
    
    // Remover logs excessivos para performance
    // Logger.log('Total de linhas na aba: ' + dados.length);
    
    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var email = String(linha[1]||'');
      var status = String(linha[7]||'');
      var tipoPunicao = String(linha[2]||'');
      
      // Remover log linha a linha para performance
      // Logger.log('Linha ' + i + ' - Email: ' + email + ' | Status: ' + status + ' | Tipo: ' + tipoPunicao);
      
      if (email.toLowerCase() === em.toLowerCase() && status === 'ATIVA') {
        Logger.log('Punição encontrada para ' + em + ' - Tipo: ' + tipoPunicao);
        
        // Verificar se é BAN (não deixar entrar)
        if (tipoPunicao === 'BAN_TEMP' || tipoPunicao === 'BAN_PERM') {
          Logger.log('Usuário está BANIDO - bloqueando acesso');
        }
        
        var dataFimStr = String(linha[6]||'');
        
        // Verificar se expirou
        if (dataFimStr && tipoPunicao === 'BAN_TEMP') {
          var dataFim = new Date(dataFimStr);
          if (!isNaN(dataFim.getTime()) && dataFim < now) {
            // Expirou - marcar como expirada
            Logger.log('Punição expirada, marcando como EXPIRADA');
            abaPunicoes.getRange(i+1, 7).setValue('EXPIRADA');
            continue;
          }
        }
        
        // Parsear detalhes do report
        var detalhesReport = {};
        try {
          if (linha[13]) {
            detalhesReport = JSON.parse(String(linha[13]));
          }
        } catch(e) {}
        
        punicaoAtiva = {
          idPunicao: String(linha[0]),
          tipo: String(linha[2]),
          quantidade: String(linha[3]),
          unidade: String(linha[4]),
          dataInicio: String(linha[5]),
          dataFim: dataFimStr,
          emailModerador: String(linha[8]),
          nomeModerador: String(linha[9]),
          dataAplicacao: String(linha[10]),
          advertencias: String(linha[11]),
          idReport: String(linha[12]||''),
          detalhesReport: detalhesReport,
          reajustadaPorApelacao: String(linha[14]||''),
          motivo: detalhesReport && detalhesReport.motivo ? detalhesReport.motivo : ''
        };
        break;
      }
    }
    
    var resultado = JSON.stringify({ ok:true, punicao:punicaoAtiva });
    cache.put(cacheKey, resultado, 60); // Cache por 1 minuto
    Logger.log('Resultado - punicaoAtiva: ' + (punicaoAtiva ? 'SIM' : 'NÃO'));
    Logger.log('=== verificarPunicaoAtiva FINALIZADO ===');
    return resultado;
  } catch(e) {
    Logger.log('Erro em verificarPunicaoAtiva: ' + e.message);
    Logger.log('Stack: ' + e.stack);
    return JSON.stringify({ ok:true, punicao:null });
  }
}

// ── Obter Recurso de Usuário para uma Punição ─────────────────────
function obterRecursoUsuario(idPunicao, emailUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
    
    var abaRecursos = obterAbaPorNome(ABA_RECURSOS);
    if (!abaRecursos) return JSON.stringify({ ok:true, recurso:null });
    
    var dados = abaRecursos.getDataRange().getValues();
    
    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var idRecPunicao = String(linha[1]||'');
      var emailRec = String(linha[2]||'');
      
      if (idRecPunicao === idPunicao && emailRec.toLowerCase() === em.toLowerCase()) {
        return JSON.stringify({
          ok: true,
          recurso: {
            idRecurso: String(linha[0]),
            idPunicao: String(linha[1]),
            emailUsuario: String(linha[2]),
            justificativa: String(linha[3]),
            dataCriacao: String(linha[7]),
            status: String(linha[6]),
            respostaAdmin: String(linha[4]||''),
            dataResposta: String(linha[8]||'')
          }
        });
      }
    }
    
    return JSON.stringify({ ok:true, recurso:null });
  } catch(e) {
    Logger.log('Erro em obterRecursoUsuario: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Criar Recurso/Apelação de Punição ─────────────────────────────
function criarRecursoPunicao(idPunicao, emailUsuario, justificativa) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
    
    var justificativaLimpa = String(justificativa||'').trim();
    if (!justificativaLimpa) return JSON.stringify({ ok:false, erro:'Justificativa é obrigatória.' });
    if (justificativaLimpa.length > 2000) return JSON.stringify({ ok:false, erro:'Justificativa muito longa (máx. 2000 caracteres).' });
    
    // Verificar se punição existe e pertence ao usuário
    var abaPunicoes = obterAbaPorNome(ABA_PUNICOES);
    if (!abaPunicoes) return JSON.stringify({ ok:false, erro:'Aba de punições não encontrada.' });
    
    var dados = abaPunicoes.getDataRange().getValues();
    var punicaoEncontrada = false;
    var punicaoData = null;
    
    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var id = String(linha[0]||'');
      var email = String(linha[1]||'');
      var status = String(linha[7]||'');
      
      if (id === idPunicao && email.toLowerCase() === em.toLowerCase()) {
        // Permitir apelação para qualquer punição ativa (MUTE, BAN_TEMP, BAN_PERM)
        if (status !== 'ATIVA') {
          return JSON.stringify({ ok:false, erro:'Esta punição não está mais ativa.' });
        }
        punicaoEncontrada = true;
        punicaoData = linha;
        break;
      }
    }
    
    if (!punicaoEncontrada) return JSON.stringify({ ok:false, erro:'Punição não encontrada.' });
    
    // Verificar se já existe recurso para esta punição (qualquer status)
    var abaRecursos = _garantirAbaRecursos();
    var dadosRecursos = abaRecursos.getDataRange().getValues();
    
    for (var i = 1; i < dadosRecursos.length; i++) {
      var idRecPunicao = String(dadosRecursos[i][1]||'');
      
      if (idRecPunicao === idPunicao) {
        return JSON.stringify({ ok:false, erro:'Já existe uma apelação para esta punição. Cada punição só pode ter uma apelação.' });
      }
    }
    
    // Criar recurso
    var abaRecursos = _garantirAbaRecursos();
    var idRecurso = Utilities.getUuid();
    var now = new Date();
    var tz = Session.getScriptTimeZone();
    
    abaRecursos.appendRow([
      idRecurso,
      idPunicao,
      em,
      justificativaLimpa,
      '', // RespostaAdmin (col 4)
      '', // EmailAdmin (col 5)
      'PENDENTE', // Status (col 6)
      Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm:ss'), // DataCriacao (col 7)
      '', // DataResposta (col 8)
      ''  // Observacoes (col 9)
    ]);
    
    return JSON.stringify({ ok:true, idRecurso:idRecurso });
  } catch(e) {
    Logger.log('Erro em criarRecursoPunicao: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Listar Recursos Pendentes (para admin) ───────────────────────
function listarRecursosPendentes() {
  try {
    Logger.log('listarRecursosPendentes: Iniciando');
    
    var abaRecursos = obterAbaPorNome(ABA_RECURSOS);
    if (!abaRecursos) {
      Logger.log('listarRecursosPendentes: Aba de recursos não encontrada');
      return JSON.stringify({ ok:true, recursos:[] });
    }
    
    var dados = abaRecursos.getDataRange().getValues();
    // Remover log para performance
    // Logger.log('listarRecursosPendentes: Total de linhas na aba de recursos: ' + dados.length);
    
    var recursos = [];
    
    // Buscar dados das punições
    var abaPunicoes = obterAbaPorNome(ABA_PUNICOES);
    var mapaPunicoes = {};
    if (abaPunicoes) {
      var dadosPunicoes = abaPunicoes.getDataRange().getValues();
      for (var i = 1; i < dadosPunicoes.length; i++) {
        var id = String(dadosPunicoes[i][0]||'');
        mapaPunicoes[id] = dadosPunicoes[i];
      }
      // Remover log para performance
      // Logger.log('listarRecursosPendentes: Mapa de punições criado com ' + Object.keys(mapaPunicoes).length + ' punições');
    }
    
    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var status = String(linha[6]||'');
      // Remover log linha a linha para performance
      // Logger.log('listarRecursosPendentes: Linha ' + i + ', status: ' + status);
      
      if (status === 'PENDENTE') {
        var idPunicao = String(linha[1]||'');
        var dadosPunicao = mapaPunicoes[idPunicao] || [];
        
        // Parsear detalhes do report
        var detalhesReport = {};
        try {
          if (dadosPunicao[13]) {
            detalhesReport = JSON.parse(String(dadosPunicao[13]));
          }
        } catch(e) {}
        
        recursos.push({
          idRecurso: String(linha[0]),
          idPunicao: idPunicao,
          emailUsuario: String(linha[2]),
          justificativa: String(linha[3]),
          respostaAdmin: String(linha[4]),
          emailAdmin: String(linha[5]),
          status: status,
          dataCriacao: String(linha[7]),
          dataResposta: String(linha[8]),
          observacoes: String(linha[9]),
          tipoPunicao: dadosPunicao[2] || '',
          quantidade: dadosPunicao[3] || '',
          unidade: dadosPunicao[4] || '',
          dataInicioPunicao: dadosPunicao[5] || '',
          dataFimPunicao: dadosPunicao[6] || '',
          advertencias: dadosPunicao[10] || '',
          emailModerador: dadosPunicao[8] || '',
          nomeModerador: dadosPunicao[9] || '',
          idReport: dadosPunicao[12] || '',
          detalhesReport: detalhesReport
        });
      }
    }
    
    Logger.log('listarRecursosPendentes: Recursos pendentes encontrados: ' + recursos.length);
    return JSON.stringify({ ok:true, recursos:recursos });
  } catch(e) {
    Logger.log('Erro em listarRecursosPendentes: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Listar Recursos Resolvidos (histórico) ───────────────────────────
function listarRecursosResolvidos() {
  try {
    var abaRecursos = obterAbaPorNome(ABA_RECURSOS);
    if (!abaRecursos) {
      abaRecursos = obterAbaPorNome('Recursos');
    }
    if (!abaRecursos) return JSON.stringify({ ok:true, recursos:[] });
    
    var dados = abaRecursos.getDataRange().getValues();
    var recursos = [];
    
    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var status = String(linha[6]||'');
      
      // Apenas recursos resolvidos (APROVADO, REJEITADO, REAJUSTADO)
      if (status === 'APROVADO' || status === 'REJEITADO' || status === 'REAJUSTADO') {
        var idPunicao = String(linha[1]||'');
        var dadosPunicao = null;
        
        // Buscar detalhes da punição
        var abaPunicoes = obterAbaPorNome(ABA_PUNICOES);
        if (abaPunicoes) {
          var dadosP = abaPunicoes.getDataRange().getValues();
          for (var j = 1; j < dadosP.length; j++) {
            if (String(dadosP[j][0]) === idPunicao) {
              dadosPunicao = dadosP[j];
              break;
            }
          }
        }
        
        recursos.push({
          idRecurso: String(linha[0]),
          idPunicao: idPunicao,
          emailUsuario: String(linha[2]),
          justificativa: String(linha[3]),
          respostaAdmin: String(linha[4]),
          emailAdmin: String(linha[5]),
          status: status,
          dataCriacao: String(linha[7]),
          dataResposta: String(linha[8]),
          tipoPunicao: dadosPunicao ? String(dadosPunicao[2]) : '',
          quantidade: dadosPunicao ? String(dadosPunicao[3]) : '',
          unidade: dadosPunicao ? String(dadosPunicao[4]) : '',
          dataFim: dadosPunicao ? String(dadosPunicao[6]) : '',
          nomeModerador: dadosPunicao ? String(dadosPunicao[9]) : '',
          emailModerador: dadosPunicao ? String(dadosPunicao[8]) : '',
          advertencias: dadosPunicao ? String(dadosPunicao[11]) : '',
          idReport: dadosPunicao ? String(dadosPunicao[12]||'') : '',
          detalhesReport: dadosPunicao && dadosPunicao[13] ? JSON.parse(String(dadosPunicao[13])) : {}
        });
      }
    }
    
    return JSON.stringify({ ok:true, recursos:recursos });
  } catch(e) {
    Logger.log('Erro em listarRecursosResolvidos: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Responder Recurso (aprovar/rejeitar) ───────────────────────────
function responderRecurso(idRecurso, emailAdmin, decisao, resposta) {
  try {
    // Remover logs excessivos para performance
    // Logger.log('=== responderRecurso INICIADO ===');
    // Logger.log('idRecurso: ' + idRecurso);
    // Logger.log('emailAdmin: ' + emailAdmin);
    // Logger.log('decisao: ' + decisao);
    // Logger.log('resposta: ' + resposta);
    
    var em = normalizarEmail(emailAdmin);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
    
    var isAdmin = verificarAdmin(em);
    var isModerador = verificarSeModerador(em);
    
    // Logger.log('isAdmin: ' + isAdmin);
    // Logger.log('isModerador: ' + isModerador);
    
    if (!isAdmin && !isModerador) {
      return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas administradores ou moderadores podem responder recursos.' });
    }
    
    var decisaoLimpa = String(decisao||'').trim().toLowerCase();
    if (decisaoLimpa !== 'aprovar' && decisaoLimpa !== 'rejeitar') {
      return JSON.stringify({ ok:false, erro:'Decisão inválida. Use "aprovar" ou "rejeitar".' });
    }
    
    var respostaLimpa = String(resposta||'').trim();
    if (!respostaLimpa) return JSON.stringify({ ok:false, erro:'Resposta é obrigatória.' });
    
    var abaRecursos = obterAbaPorNome(ABA_RECURSOS);
    if (!abaRecursos) return JSON.stringify({ ok:false, erro:'Aba de recursos não encontrada.' });
    
    var dados = abaRecursos.getDataRange().getValues();
    // Remover log para performance
    // Logger.log('Total de linhas na aba de recursos: ' + dados.length);
    
    var encontrado = false;
    var idPunicao = '';
    var emailUsuario = '';
    
    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var id = String(linha[0]||'');
      var status = String(linha[6]||'');
      
      // Remover log linha a linha para performance
      // Logger.log('Linha ' + i + ': id=' + id + ', status=' + status);
      
      if (id === idRecurso) {
        if (status !== 'PENDENTE') {
          return JSON.stringify({ ok:false, erro:'Este recurso já foi respondido.' });
        }
        
        idPunicao = String(linha[1]||'');
        emailUsuario = String(linha[2]||''); // Email do usuário que fez a apelação
        
        var now = new Date();
        var tz = Session.getScriptTimeZone();
        
        abaRecursos.getRange(i+1, 5).setValue(respostaLimpa); // RespostaAdmin (col 5)
        abaRecursos.getRange(i+1, 6).setValue(em); // EmailAdmin (col 6)
        abaRecursos.getRange(i+1, 7).setValue(decisaoLimpa === 'aprovar' ? 'APROVADO' : 'REJEITADO'); // Status (col 7)
        abaRecursos.getRange(i+1, 9).setValue(Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm:ss')); // DataResposta (col 9)
        
        encontrado = true;
        break;
      }
    }
    
    if (!encontrado) return JSON.stringify({ ok:false, erro:'Recurso não encontrado.' });
    
    // Se aprovado, remover punição
    if (decisaoLimpa === 'aprovar' && idPunicao) {
      // Remover log para performance
      // Logger.log('Revogando punição: ' + idPunicao);
      var abaPunicoes = obterAbaPorNome(ABA_PUNICOES);
      if (abaPunicoes) {
        var dadosPunicoes = abaPunicoes.getDataRange().getValues();
        // Remover log para performance
        // Logger.log('Total de punições: ' + dadosPunicoes.length);
        for (var i = 1; i < dadosPunicoes.length; i++) {
          var id = String(dadosPunicoes[i][0]||'');
          // Remover log linha a linha para performance
          // Logger.log('Verificando punição: ' + id);
          if (id === idPunicao) {
            abaPunicoes.getRange(i+1, 8).setValue('REVOGADA');
            // Remover log para performance
            // Logger.log('Punição revogada com sucesso');
            break;
          }
        }
      }
      
      // Limpar cache do usuário (não do admin)
      if (emailUsuario) {
        var cache = CacheService.getScriptCache();
        cache.remove('punicao_' + emailUsuario.toLowerCase());
      }
    }
    
    return JSON.stringify({ ok:true });
  } catch(e) {
    Logger.log('Erro em responderRecurso: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Reajustar Punição (alterar tipo/quantidade/unidade) ─────────────
function reajustarPunicao(idPunicao, novoTipo, novaQuantidade, novaUnidade, emailAdmin, motivoReajuste) {
  try {
    // Remover logs excessivos para performance
    // Logger.log('=== reajustarPunicao INICIADO ===');
    // Logger.log('idPunicao: ' + idPunicao);
    // Logger.log('novoTipo: ' + novoTipo);
    // Logger.log('novaQuantidade: ' + novaQuantidade);
    // Logger.log('novaUnidade: ' + novaUnidade);
    
    var em = normalizarEmail(emailAdmin);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
    
    var isAdmin = verificarAdmin(em);
    var isModerador = verificarSeModerador(em);
    
    if (!isAdmin && !isModerador) {
      return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas administradores ou moderadores podem reajustar punições.' });
    }
    
    var tipoLimpo = String(novoTipo||'').trim().toLowerCase();
    var tiposValidos = ['mute', 'ban_temp', 'ban_perm'];
    if (tiposValidos.indexOf(tipoLimpo) === -1) {
      return JSON.stringify({ ok:false, erro:'Tipo de punição inválido. Use: mute, ban_temp ou ban_perm.' });
    }
    
    var quantidadeLimpa = String(novaQuantidade||'').trim();
    var unidadeLimpa = String(novaUnidade||'').trim();
    
    if (tipoLimpo !== 'ban_perm' && (!quantidadeLimpa || !unidadeLimpa)) {
      return JSON.stringify({ ok:false, erro:'Quantidade e unidade são obrigatórias para punições temporárias.' });
    }
    
    var motivoLimpo = String(motivoReajuste||'').trim();
    if (!motivoLimpo) return JSON.stringify({ ok:false, erro:'Motivo do reajuste é obrigatório.' });
    
    var abaPunicoes = obterAbaPorNome(ABA_PUNICOES);
    if (!abaPunicoes) return JSON.stringify({ ok:false, erro:'Aba de punições não encontrada.' });
    
    var dados = abaPunicoes.getDataRange().getValues();
    var encontrado = false;
    var emailUsuario = '';
    
    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var id = String(linha[0]||'');
      var status = String(linha[7]||'');
      
      if (id === idPunicao) {
        if (status !== 'ATIVA') {
          return JSON.stringify({ ok:false, erro:'Esta punição não está mais ativa.' });
        }
        
        emailUsuario = String(linha[1]||'');
        
        // Calcular nova data de fim se for temporária
        var novoDataFim = '';
        if (tipoLimpo !== 'ban_perm') {
          var multiplicador = 1;
          if (unidadeLimpa === 'horas') multiplicador = 60 * 60 * 1000;
          else if (unidadeLimpa === 'dias') multiplicador = 24 * 60 * 60 * 1000;
          else if (unidadeLimpa === 'meses') multiplicador = 30 * 24 * 60 * 60 * 1000;
          
          var dataInicio = new Date(linha[5]);
          var dataFim = new Date(dataInicio.getTime() + (parseInt(quantidadeLimpa) * multiplicador));
          var tz = Session.getScriptTimeZone();
          novoDataFim = Utilities.formatDate(dataFim, tz, 'dd/MM/yyyy HH:mm:ss');
        }
        
        var now = new Date();
        var tz = Session.getScriptTimeZone();
        
        // Atualizar punição
        abaPunicoes.getRange(i+1, 3).setValue(tipoLimpo.toUpperCase());
        abaPunicoes.getRange(i+1, 4).setValue(quantidadeLimpa);
        abaPunicoes.getRange(i+1, 5).setValue(unidadeLimpa);
        if (novoDataFim) abaPunicoes.getRange(i+1, 6).setValue(novoDataFim);
        abaPunicoes.getRange(i+1, 15).setValue('Sim - ' + motivoLimpo + ' (' + Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm:ss') + ')');
        
        encontrado = true;
        break;
      }
    }
    
    if (!encontrado) return JSON.stringify({ ok:false, erro:'Punição não encontrada.' });
    
    // Marcar apelação como REAJUSTADO
    var abaRecursos = obterAbaPorNome(ABA_RECURSOS);
    
    // Se não encontrar com nome novo, tentar com nome antigo
    if (!abaRecursos) {
      abaRecursos = obterAbaPorNome('Recursos');
    }
    
    if (abaRecursos) {
      var dadosRecursos = abaRecursos.getDataRange().getValues();
      
      for (var i = 1; i < dadosRecursos.length; i++) {
        var linha = dadosRecursos[i];
        var idPunicaoRecurso = String(linha[1]||'');
        var statusRecurso = String(linha[6]||'');
        
        if (idPunicaoRecurso === idPunicao && statusRecurso === 'PENDENTE') {
          abaRecursos.getRange(i+1, 5).setValue('Punição reajustada: ' + motivoLimpo); // RespostaAdmin (col 5)
          abaRecursos.getRange(i+1, 6).setValue(em); // EmailAdmin (col 6)
          abaRecursos.getRange(i+1, 7).setValue('REAJUSTADO'); // Status (col 7) - REAJUSTADO em vez de APROVADO
          abaRecursos.getRange(i+1, 9).setValue(Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm:ss')); // DataResposta (col 9)
          break;
        }
      }
    }
    
    // Limpar cache
    var cache = CacheService.getScriptCache();
    cache.remove('punicao_' + emailUsuario.toLowerCase());
    
    return JSON.stringify({ ok:true });
  } catch(e) {
    Logger.log('Erro em reajustarPunicao: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Garantir Aba de Recursos ─────────────────────────────────────
function _garantirAbaRecursos() {
  var aba = obterAbaPorNome(ABA_RECURSOS);
  if (!aba) {
    var ss = obterPlanilhaChat();
    aba = ss.insertSheet(ABA_RECURSOS);
    aba.appendRow(['IdRecurso', 'IdPunicao', 'EmailUsuario', 'Justificativa', 'RespostaAdmin', 'EmailAdmin', 'Status', 'DataCriacao', 'DataResposta', 'Observacoes']);
  }
  return aba;
}

// ── Sistema de Estatísticas Avançadas ─────────────────────────
function obterEstatisticasAvancadas() {
  try {
    var abaMsg = obterAbaPorNome(ABA_MENSAGENS);
    var abaUsuarios = obterAbaPorNome(ABA_USUARIOS);
    var abaGrupos = obterAbaPorNome(ABA_GRUPOS);

    var stats = {
      totalMensagens: 0,
      totalUsuarios: 0,
      totalGrupos: 0,
      mensagensPorDia: {},
      usuariosMaisAtivos: {},
      gruposMaisAtivos: {},
      mensagensUltimaSemana: 0,
      mensagensUltimoMes: 0
    };

    if (abaMsg) {
      var dadosMsg = abaMsg.getDataRange().getValues();
      stats.totalMensagens = dadosMsg.length - 1;

      var agora = Date.now();
      var umaSemanaAtras = agora - (7 * 24 * 60 * 60 * 1000);
      var umMesAtras = agora - (30 * 24 * 60 * 60 * 1000);

      for (var i = 1; i < dadosMsg.length; i++) {
        var linha = dadosMsg[i];
        var data = String(linha[0]||'');
        var remetente = String(linha[2]||'');
        var destinatario = String(linha[3]||'');
        var hora = linha[1];

        // Mensagens por dia
        if (data) {
          stats.mensagensPorDia[data] = (stats.mensagensPorDia[data] || 0) + 1;
        }

        // Usuários mais ativos
        if (remetente) {
          stats.usuariosMaisAtivos[remetente] = (stats.usuariosMaisAtivos[remetente] || 0) + 1;
        }

        // Grupos mais ativos
        if (destinatario && destinatario !== 'geral') {
          stats.gruposMaisAtivos[destinatario] = (stats.gruposMaisAtivos[destinatario] || 0) + 1;
        }

        // Mensagens recentes
        if (hora) {
          var tsMsg = new Date(data + ' ' + hora).getTime();
          if (!isNaN(tsMsg)) {
            if (tsMsg >= umaSemanaAtras) stats.mensagensUltimaSemana++;
            if (tsMsg >= umMesAtras) stats.mensagensUltimoMes++;
          }
        }
      }
    }

    if (abaUsuarios) {
      stats.totalUsuarios = abaUsuarios.getLastRow() - 1;
    }

    if (abaGrupos) {
      stats.totalGrupos = abaGrupos.getLastRow() - 1;
    }

    // Converter objetos para arrays ordenadas
    var usuariosOrdenados = Object.keys(stats.usuariosMaisAtivos)
      .map(function(u){ return { usuario: u, count: stats.usuariosMaisAtivos[u] }; })
      .sort(function(a,b){ return b.count - a.count; })
      .slice(0, 10);

    var gruposOrdenados = Object.keys(stats.gruposMaisAtivos)
      .map(function(g){ return { grupo: g, count: stats.gruposMaisAtivos[g] }; })
      .sort(function(a,b){ return b.count - a.count; })
      .slice(0, 10);

    var diasOrdenados = Object.keys(stats.mensagensPorDia)
      .map(function(d){ return { data: d, count: stats.mensagensPorDia[d] }; })
      .sort(function(a,b){ return new Date(b.data) - new Date(a.data); })
      .slice(0, 30);

    return JSON.stringify({
      ok: true,
      stats: {
        totalMensagens: stats.totalMensagens,
        totalUsuarios: stats.totalUsuarios,
        totalGrupos: stats.totalGrupos,
        mensagensUltimaSemana: stats.mensagensUltimaSemana,
        mensagensUltimoMes: stats.mensagensUltimoMes,
        usuariosMaisAtivos: usuariosOrdenados,
        gruposMaisAtivos: gruposOrdenados,
        mensagensPorDia: diasOrdenados
      }
    });
  } catch(e) {
    Logger.log('Erro em obterEstatisticasAvancadas: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Sistema de Backup e Restore ───────────────────────────────
function criarBackupCompleto() {
  try {
    var planilha = obterPlanilhaChat();
    var est = obterEstruturaAbas();
    var backup = {};
    var now = new Date();
    var timestamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');

    Object.keys(est).forEach(function(nomeAba) {
      var aba = planilha.getSheetByName(nomeAba);
      if (!aba) return;

      var dados = aba.getDataRange().getValues();
      backup[nomeAba] = {
        headers: dados[0],
        linhas: dados.slice(1),
        totalLinhas: dados.length - 1
      };
    });

    // Salvar backup como arquivo JSON no Drive
    var nomeArquivo = 'backup_sonne_' + timestamp + '.json';
    var arquivo = DriveApp.createFile(nomeArquivo, JSON.stringify(backup), MimeType.JSON);
    arquivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return JSON.stringify({ 
      ok: true, 
      arquivoId: arquivo.getId(), 
      nomeArquivo: nomeArquivo,
      tamanho: arquivo.getSize(),
      url: arquivo.getUrl()
    });
  } catch(e) {
    Logger.log('Erro em criarBackupCompleto: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function restaurarBackup(arquivoId, emailUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var isAdmin = verificarAdmin(em);
    if (!isAdmin) return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas administradores podem restaurar backups.' });

    var arquivo = DriveApp.getFileById(arquivoId);
    var conteudo = arquivo.getBlob().getDataAsString();
    var backup = JSON.parse(conteudo);

    var planilha = obterPlanilhaChat();
    var est = obterEstruturaAbas();

    Object.keys(backup).forEach(function(nomeAba) {
      var dadosBackup = backup[nomeAba];
      var aba = planilha.getSheetByName(nomeAba);

      if (!aba) {
        aba = planilha.insertSheet(nomeAba);
      }

      // Limpar aba existente
      aba.clear();

      // Restaurar headers
      if (dadosBackup.headers && dadosBackup.headers.length > 0) {
        aba.getRange(1, 1, 1, dadosBackup.headers.length).setValues([dadosBackup.headers]);
      }

      // Restaurar linhas
      if (dadosBackup.linhas && dadosBackup.linhas.length > 0) {
        aba.getRange(2, 1, dadosBackup.linhas.length, dadosBackup.linhas[0].length).setValues(dadosBackup.linhas);
      }

      // Aplicar formatação
      if (est[nomeAba]) {
        aplicarCabecalhoEAjustes(aba, est[nomeAba].headers, est[nomeAba].larguras);
        formatarLinhaCabecalho(aba, est[nomeAba].headers.length);
        aba.setFrozenRows(1);
      }
    });

    // Limpar cache após restauração
    try {
      CacheService.getScriptCache().removeAll();
    } catch(e) {
      Logger.log('Erro ao limpar cache após restore: ' + e.message);
    }

    return JSON.stringify({ ok:true, mensagem:'Backup restaurado com sucesso.' });
  } catch(e) {
    Logger.log('Erro em restaurarBackup: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarBackupsDisponiveis() {
  try {
    var arquivos = DriveApp.getFilesByName('backup_sonne_');
    var backups = [];

    while (arquivos.hasNext()) {
      var arquivo = arquivos.next();
      if (arquivo.getName().indexOf('backup_sonne_') === 0) {
        backups.push({
          id: arquivo.getId(),
          nome: arquivo.getName(),
          tamanho: arquivo.getSize(),
          dataCriacao: Utilities.formatDate(arquivo.getDateCreated(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
          url: arquivo.getUrl()
        });
      }
    }

    // Ordenar por data (mais recente primeiro)
    backups.sort(function(a, b) {
      return new Date(b.dataCriacao) - new Date(a.dataCriacao);
    });

    return JSON.stringify({ ok:true, backups: backups });
  } catch(e) {
    Logger.log('Erro em listarBackupsDisponiveis: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Sistema de Threads/Conversas Aninhadas ─────────────────────
function _garantirAbaThreads() {
  var aba = obterAbaPorNome(ABA_THREADS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_THREADS);
    var est = obterEstruturaAbas().Threads;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

function _garantirAbaMensagensThreads() {
  var aba = obterAbaPorNome(ABA_MENSAGENS_THREADS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_MENSAGENS_THREADS);
    var est = obterEstruturaAbas().MensagensThreads;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  }
  return aba;
}

function criarThread(idMensagemOriginal, idGrupo, emailCriador, nomeCriador, titulo) {
  try {
    var em = normalizarEmail(emailCriador);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var isAdmin = verificarAdmin(em);
    if (!isAdmin) return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas administradores podem criar threads.' });

    var tituloLimpo = String(titulo||'').trim();
    if (!tituloLimpo) return JSON.stringify({ ok:false, erro:'Título é obrigatório.' });

    var aba = _garantirAbaThreads();
    var idThread = Utilities.getUuid();
    var now = new Date();

    aba.appendRow([
      idThread,
      idMensagemOriginal,
      idGrupo,
      em,
      nomeCriador,
      tituloLimpo,
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
      'ATIVA',
      0 // NumMensagens
    ]);

    return JSON.stringify({ ok:true, idThread: idThread });
  } catch(e) {
    Logger.log('Erro em criarThread: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarThreadsGrupo(idGrupo) {
  try {
    var aba = obterAbaPorNome(ABA_THREADS);
    if (!aba) return JSON.stringify({ ok:true, threads:[] });

    var dados = aba.getDataRange().getValues();
    var threads = [];

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var grupoId = String(linha[2]||'');

      if (grupoId !== idGrupo) continue;

      threads.push({
        idThread: String(linha[0]),
        idMensagemOriginal: String(linha[1]),
        idGrupo: grupoId,
        criadorEmail: String(linha[3]),
        criadorNome: String(linha[4]),
        titulo: String(linha[5]),
        dataCriacao: String(linha[6]),
        status: String(linha[7])
      });
    }

    return JSON.stringify({ ok:true, threads: threads });
  } catch(e) {
    Logger.log('Erro em listarThreadsGrupo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function obterMensagensThread(idThread) {
  try {
    var abaMsg = obterAbaPorNome(ABA_MENSAGENS_THREADS);
    if (!abaMsg) return JSON.stringify({ ok:true, mensagens:[] });

    var dados = abaMsg.getDataRange().getValues();
    var mensagens = [];

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var threadId = String(linha[1]||'');

      if (threadId === idThread) {
        mensagens.push({
          idMsg: String(linha[0]),
          idThread: threadId,
          data: String(linha[5]),
          hora: String(linha[6]),
          remetente: String(linha[2]),
          remetenteNome: String(linha[3]),
          mensagem: String(linha[4]),
          textoOriginal: String(linha[11]||''),
          reacoes: String(linha[8]||'{}'),
          editada: String(linha[9]||'Não'),
          statusMsg: String(linha[10]||'ENVIADA')
        });
      }
    }

    // Ordenar por data/hora
    mensagens.sort(function(a, b) {
      return new Date(a.data + ' ' + a.hora) - new Date(b.data + ' ' + b.hora);
    });

    return JSON.stringify({ ok:true, mensagens: mensagens });
  } catch(e) {
    Logger.log('Erro em obterMensagensThread: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function enviarMensagemThread(idThread, mensagem, emailUsuario, nomeUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var msgLimpa = String(mensagem||'').trim();
    if (!msgLimpa) return JSON.stringify({ ok:false, erro:'Mensagem vazia.' });

    // Verificar se thread existe e está ativa
    var abaThreads = obterAbaPorNome(ABA_THREADS);
    if (!abaThreads) return JSON.stringify({ ok:false, erro:'Thread não encontrada.' });

    var dadosThreads = abaThreads.getDataRange().getValues();
    var threadEncontrada = false;
    var linhaThread = -1;

    for (var i = 1; i < dadosThreads.length; i++) {
      if (String(dadosThreads[i][0]) === idThread && String(dadosThreads[i][7]) === 'ATIVA') {
        threadEncontrada = true;
        linhaThread = i;
        break;
      }
    }

    if (!threadEncontrada) return JSON.stringify({ ok:false, erro:'Thread não encontrada ou inativa.' });

    var trava = LockService.getScriptLock();
    try {
      trava.waitLock(6000);

      var abaMsg = _garantirAbaMensagensThreads();
      var idMensagem = Utilities.getUuid();
      var now = new Date();
      var tz = Session.getScriptTimeZone();

      // Processar links na mensagem
      var msgComLinks = processarLinks(msgLimpa);

      abaMsg.appendRow([
        idMensagem,
        idThread,
        em,
        nomeUsuario,
        msgComLinks,
        Utilities.formatDate(now, tz, 'dd/MM/yyyy'),
        Utilities.formatDate(now, tz, 'HH:mm:ss'),
        '',
        '{}',
        'Não',
        'ENVIADA',
        msgLimpa,
        ''
      ]);

      // Atualizar contador de mensagens na thread
      var numAtual = parseInt(dadosThreads[linhaThread][8] || 0);
      abaThreads.getRange(linhaThread + 1, 9).setValue(numAtual + 1);

      SpreadsheetApp.flush();

      return JSON.stringify({ ok:true, idMensagem: idMensagem });
    } finally {
      trava.releaseLock();
    }
  } catch(e) {
    Logger.log('Erro em enviarMensagemThread: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarThreadsPorMensagem(idMensagemOriginal) {
  try {
    var aba = obterAbaPorNome(ABA_THREADS);
    if (!aba) return JSON.stringify({ ok:true, threads:[] });

    var dados = aba.getDataRange().getValues();
    var threads = [];

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var msgOriginal = String(linha[1]||'');

      if (msgOriginal === idMensagemOriginal && String(linha[7]) === 'ATIVA') {
        threads.push({
          idThread: String(linha[0]),
          idMensagemOriginal: msgOriginal,
          idGrupo: String(linha[2]),
          criadorEmail: String(linha[3]),
          criadorNome: String(linha[4]),
          titulo: String(linha[5]),
          dataCriacao: String(linha[6]),
          status: String(linha[7]),
          numMensagens: parseInt(linha[8] || 0)
        });
      }
    }

    return JSON.stringify({ ok:true, threads: threads });
  } catch(e) {
    Logger.log('Erro em listarThreadsPorMensagem: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Funções de Cache Otimizadas ───────────────────────────────
function cachePut(chave, valor, ttl) {
  try {
    var cache = CacheService.getScriptCache();
    cache.put(CACHE_PREFIXO + chave, valor, ttl || CACHE_TTL_MEDIO);
  } catch(e) {
    Logger.log('Erro em cachePut: ' + e.message);
  }
}

function cacheGet(chave) {
  try {
    var cache = CacheService.getScriptCache();
    return cache.get(CACHE_PREFIXO + chave);
  } catch(e) {
    Logger.log('Erro em cacheGet: ' + e.message);
    return null;
  }
}

function cacheRemove(chave) {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(CACHE_PREFIXO + chave);
  } catch(e) {
    Logger.log('Erro em cacheRemove: ' + e.message);
  }
}

function cacheInvalidarPrefixo(prefixo) {
  try {
    var cache = CacheService.getScriptCache();
    var chaves = cache.getAll();
    Object.keys(chaves).forEach(function(chave) {
      if (chave.indexOf(CACHE_PREFIXO + prefixo) === 0) {
        cache.remove(chave);
      }
    });
  } catch(e) {
    Logger.log('Erro em cacheInvalidarPrefixo: ' + e.message);
  }
}

// ── Cache de Usuários (otimização para evitar chamadas repetidas) ──
function obterMapaUsuarios() {
  var cacheKey = 'mapa_usuarios';
  var cached = cacheGet(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch(e){}
  }
  
  var usuarios = JSON.parse(listarTodosUsuarios());
  var mapa = {};
  usuarios.forEach(function(u){
    mapa[u.nome.toLowerCase()] = u;
    mapa[u.email.toLowerCase()] = u;
  });
  
  cachePut(cacheKey, JSON.stringify(mapa), CACHE_TTL_MEDIO);
  return mapa;
}

function invalidarCacheUsuarios() {
  cacheRemove('mapa_usuarios');
}

// ── Cache de Mensagens Atualizadas (para propagar reações em tempo real) ──
function registrarMensagemAtualizada(idGrupo, idMsg, tipoAtualizacao) {
  try {
    var cacheKey = 'msg_atualizadas_' + idGrupo;
    var cache = CacheService.getScriptCache();
    var cached = cache.get(cacheKey);
    var atualizacoes = cached ? JSON.parse(cached) : {};
    
    atualizacoes[idMsg] = {
      tipo: tipoAtualizacao, // 'reacao', 'editada', 'status'
      ts: Date.now()
    };
    
    // Manter apenas as últimas 50 atualizações para não acumular
    var chaves = Object.keys(atualizacoes);
    if (chaves.length > 50) {
      chaves.sort(function(a, b){
        return atualizacoes[a].ts - atualizacoes[b].ts;
      });
      chaves.slice(0, chaves.length - 50).forEach(function(k){
        delete atualizacoes[k];
      });
    }
    
    cache.put(cacheKey, JSON.stringify(atualizacoes), 60); // 60 segundos
  } catch(e) {
    Logger.log('Erro em registrarMensagemAtualizada: ' + e.message);
  }
}

function obterMensagensAtualizadas(idGrupo) {
  try {
    var cacheKey = 'msg_atualizadas_' + idGrupo;
    var cache = CacheService.getScriptCache();
    var cached = cache.get(cacheKey);
    return cached ? JSON.parse(cached) : {};
  } catch(e) {
    return {};
  }
}

function limparMensagensAtualizadas(idGrupo) {
  try {
    var cacheKey = 'msg_atualizadas_' + idGrupo;
    cacheRemove(cacheKey);
  } catch(e){}
}

// ── Sistema de Regras de Grupo ───────────────────────────────
function _garantirAbaRegras() {
  var aba = obterAbaPorNome(ABA_REGRAS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_REGRAS);
    var est = obterEstruturaAbas().Regras;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
    aba.setFrozenRows(1);
  } else {
    // Verificar se a estrutura está correta
    var dados = aba.getDataRange().getValues();
    if (dados.length > 0) {
      var headers = dados[0];
      var est = obterEstruturaAbas().Regras;
      var headersCorretos = est.headers;
      
      var estruturaCorreta = true;
      for (var i = 0; i < headersCorretos.length; i++) {
        if (headers[i] !== headersCorretos[i]) {
          estruturaCorreta = false;
          break;
        }
      }
      
      if (!estruturaCorreta) {
        Logger.log('Estrutura da aba Regras incorreta, recriando...');
        var ss = obterPlanilhaChat();
        ss.deleteSheet(aba);
        aba = ss.insertSheet(ABA_REGRAS);
        aplicarCabecalhoEAjustes(aba, headersCorretos, est.larguras);
        formatarLinhaCabecalho(aba, headersCorretos.length);
        aba.setFrozenRows(1);
      }
    }
  }
  return aba;
}

function criarRegraGrupo(idGrupo, titulo, descricao, emailCriador, nomeCriador) {
  try {
    var em = normalizarEmail(emailCriador);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var tituloLimpo = String(titulo||'').trim();
    if (!tituloLimpo) return JSON.stringify({ ok:false, erro:'Título é obrigatório.' });

    var descricaoLimpa = String(descricao||'').trim();
    if (!descricaoLimpa) return JSON.stringify({ ok:false, erro:'Descrição é obrigatória.' });

    var aba = _garantirAbaRegras();
    var idRegra = Utilities.getUuid();
    var now = new Date();

    aba.appendRow([
      idRegra,
      idGrupo,
      tituloLimpo,
      descricaoLimpa,
      em,
      nomeCriador,
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
      'ATIVA'
    ]);

    return JSON.stringify({ ok:true, idRegra: idRegra });
  } catch(e) {
    Logger.log('Erro em criarRegraGrupo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarRegrasGrupo(idGrupo) {
  try {
    Logger.log('listarRegrasGrupo chamado com idGrupo: ' + idGrupo);
    var aba = obterAbaPorNome(ABA_REGRAS);
    if (!aba) {
      Logger.log('Aba ' + ABA_REGRAS + ' não encontrada');
      return JSON.stringify({ ok:true, regras:[] });
    }

    var dados = aba.getDataRange().getValues();
    Logger.log('Linhas na aba de regras: ' + dados.length);
    var regras = [];

    // Buscar nomes dos grupos para exibição (apenas se necessário)
    var mapaGrupos = {};
    var precisaNomes = !idGrupo; // Só precisa de nomes se estiver listando todas
    if (precisaNomes) {
      var cache = CacheService.getScriptCache();
      var cacheKey = 'mapa_grupos_v' + SISTEMA_VERSAO;
      var cached = cache.get(cacheKey);
      if (cached) {
        try {
          mapaGrupos = JSON.parse(cached);
        } catch(e) {}
      }
      
      // Se não estiver em cache, buscar e armazenar
      if (!mapaGrupos || Object.keys(mapaGrupos).length === 0) {
        var abaGrupos = obterAbaPorNome(ABA_GRUPOS);
        if (abaGrupos) {
          var dadosGrupos = abaGrupos.getDataRange().getValues();
          for (var i = 1; i < dadosGrupos.length; i++) {
            var grupoId = String(dadosGrupos[i][0]||'');
            var grupoNome = String(dadosGrupos[i][1]||'');
            if (grupoId) mapaGrupos[grupoId] = grupoNome;
          }
          // Cache por 5 minutos
          cache.put(cacheKey, JSON.stringify(mapaGrupos), 300);
        }
      }
    }

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var grupoId = String(linha[1]||'');

      // Se idGrupo for especificado, filtra por grupo. Se vazio, retorna todas
      if (idGrupo && grupoId !== idGrupo) continue;

      var regra = {
        idRegra: String(linha[0]),
        idGrupo: grupoId,
        nomeGrupo: precisaNomes ? (mapaGrupos[grupoId] || grupoId) : grupoId,
        titulo: String(linha[2]),
        descricao: String(linha[3]),
        criadorEmail: String(linha[4]),
        criadorNome: String(linha[5]),
        dataCriacao: String(linha[6]),
        status: String(linha[7])
      };
      Logger.log('Regra encontrada: ' + regra.idRegra + ' - ' + regra.titulo);
      regras.push(regra);
    }

    Logger.log('Total de regras retornadas: ' + regras.length);
    return JSON.stringify({ ok:true, regras: regras });
  } catch(e) {
    Logger.log('Erro em listarRegrasGrupo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function removerRegraGrupo(idRegra, emailUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var aba = obterAbaPorNome(ABA_REGRAS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba de regras não encontrada.' });

    var dados = aba.getDataRange().getValues();
    var encontrado = false;

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var id = String(linha[0]||'');
      var criadorEmail = String(linha[4]||'');

      if (id === idRegra) {
        if (criadorEmail.toLowerCase() !== em.toLowerCase()) {
          return JSON.stringify({ ok:false, erro:'Permissão negada. Você só pode remover suas próprias regras.' });
        }

        aba.deleteRow(i+1);
        encontrado = true;
        break;
      }
    }

    if (!encontrado) return JSON.stringify({ ok:false, erro:'Regra não encontrada.' });

    return JSON.stringify({ ok:true });
  } catch(e) {
    Logger.log('Erro em removerRegraGrupo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function editarRegraGrupo(idRegra, emailUsuario, novoTitulo, novaDescricao) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    var tituloLimpo = String(novoTitulo||'').trim();
    if (!tituloLimpo) return JSON.stringify({ ok:false, erro:'Título é obrigatório.' });

    var descricaoLimpa = String(novaDescricao||'').trim();
    if (!descricaoLimpa) return JSON.stringify({ ok:false, erro:'Descrição é obrigatória.' });

    var aba = obterAbaPorNome(ABA_REGRAS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba de regras não encontrada.' });

    var dados = aba.getDataRange().getValues();
    var encontrado = false;

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var id = String(linha[0]||'');
      var criadorEmail = String(linha[4]||'');

      if (id === idRegra) {
        if (criadorEmail.toLowerCase() !== em.toLowerCase()) {
          return JSON.stringify({ ok:false, erro:'Permissão negada. Você só pode editar suas próprias regras.' });
        }

        aba.getRange(i+1, 3).setValue(tituloLimpo);
        aba.getRange(i+1, 4).setValue(descricaoLimpa);
        encontrado = true;
        break;
      }
    }

    if (!encontrado) return JSON.stringify({ ok:false, erro:'Regra não encontrada.' });

    return JSON.stringify({ ok:true });
  } catch(e) {
    Logger.log('Erro em editarRegraGrupo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function criarAutomacaoBemVindo(idGrupo, mensagem, emailCriador) {
  try {
    var em = normalizarEmail(emailCriador);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    // Verificar permissão: apenas admin pode configurar automações
    var isAdmin = verificarAdmin(em);
    if (!isAdmin) {
      return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas administradores podem configurar automações.' });
    }

    var msgLimpa = String(mensagem||'').trim();
    if (!msgLimpa) return JSON.stringify({ ok:false, erro:'Mensagem vazia.' });
    
    var trava = LockService.getScriptLock();
    try {
      trava.waitLock(6000);
      
      var aba = _garantirAbaAutomacao();
      var config = { mensagem: msgLimpa };
      
      // Verificar se já existe automação de bem-vindo para este grupo
      var dados = aba.getDataRange().getValues();
      for (var i = 1; i < dados.length; i++) {
        if (String(dados[i][0]) === String(idGrupo) && String(dados[i][1]) === 'BEM_VINDO') {
          // Atualizar existente
          aba.getRange(i + 1, 2).setValue(JSON.stringify(config));
          SpreadsheetApp.flush();
          return JSON.stringify({ ok:true, atualizado:true });
        }
      }
      
      // Criar nova
      aba.appendRow([
        String(idGrupo),
        'BEM_VINDO',
        JSON.stringify(config),
        'ATIVA',
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss')
      ]);
      SpreadsheetApp.flush();
      
      return JSON.stringify({ ok:true });
    } finally {
      trava.releaseLock();
    }
  } catch(e) {
    Logger.log('Erro em criarAutomacaoBemVindo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function criarAutomacaoModAuto(idGrupo, palavrasBloqueadas, emailCriador) {
  try {
    var em = normalizarEmail(emailCriador);
    if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });

    // Verificar permissão: apenas admin pode configurar automações
    var isAdmin = verificarAdmin(em);
    if (!isAdmin) {
      return JSON.stringify({ ok:false, erro:'Permissão negada. Apenas administradores podem configurar automações.' });
    }

    if (!palavrasBloqueadas || !Array.isArray(palavrasBloqueadas) || palavrasBloqueadas.length === 0) {
      return JSON.stringify({ ok:false, erro:'Lista de palavras vazia.' });
    }
    
    var palavras = palavrasBloqueadas.map(function(p){ return String(p||'').trim().toLowerCase(); }).filter(Boolean);
    
    var trava = LockService.getScriptLock();
    try {
      trava.waitLock(6000);
      
      var aba = _garantirAbaAutomacao();
      var config = { palavras: palavras };
      
      // Verificar se já existe automação de moderação para este grupo
      var dados = aba.getDataRange().getValues();
      for (var i = 1; i < dados.length; i++) {
        if (String(dados[i][0]) === String(idGrupo) && String(dados[i][1]) === 'MODERACAO_AUTO') {
          // Atualizar existente
          aba.getRange(i + 1, 2).setValue(JSON.stringify(config));
          SpreadsheetApp.flush();
          return JSON.stringify({ ok:true, atualizado:true });
        }
      }
      
      // Criar nova
      aba.appendRow([
        String(idGrupo),
        'MODERACAO_AUTO',
        JSON.stringify(config),
        'ATIVA',
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss')
      ]);
      SpreadsheetApp.flush();
      
      return JSON.stringify({ ok:true });
    } finally {
      trava.releaseLock();
    }
  } catch(e) {
    Logger.log('Erro em criarAutomacaoModAuto: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function verificarModeracaoAuto(idGrupo, mensagem, emailUsuario) {
  try {
    var aba = obterAbaPorNome(ABA_AUTOMACAO);
    if (!aba) return JSON.stringify({ ok:true, permitido:true });
    
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) === String(idGrupo) && String(dados[i][1]) === 'MODERACAO_AUTO' && String(dados[i][3]) === 'ATIVA') {
        var config = JSON.parse(String(dados[i][2]));
        var palavras = config.palavras || [];
        var msgLower = String(mensagem||'').toLowerCase();
        
        for (var j = 0; j < palavras.length; j++) {
          if (msgLower.indexOf(palavras[j]) !== -1) {
            return JSON.stringify({ ok:true, permitido:false, palavra:palavras[j] });
          }
        }
      }
    }
    
    return JSON.stringify({ ok:true, permitido:true });
  } catch(e) {
    Logger.log('Erro em verificarModeracaoAuto: ' + e.message);
    return JSON.stringify({ ok:true, permitido:true });
  }
}

function obterAutomacaoBemVindo(idGrupo) {
  try {
    var aba = obterAbaPorNome(ABA_AUTOMACAO);
    if (!aba) return JSON.stringify({ ok:true, mensagem:null });
    
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) === String(idGrupo) && String(dados[i][1]) === 'BEM_VINDO' && String(dados[i][3]) === 'ATIVA') {
        var config = JSON.parse(String(dados[i][2]));
        return JSON.stringify({ ok:true, mensagem:config.mensagem });
      }
    }
    
    return JSON.stringify({ ok:true, mensagem:null });
  } catch(e) {
    Logger.log('Erro em obterAutomacaoBemVindo: ' + e.message);
    return JSON.stringify({ ok:true, mensagem:null });
  }
}

function listarAutomacoesGrupo(idGrupo) {
  try {
    var aba = obterAbaPorNome(ABA_AUTOMACAO);
    if (!aba) return JSON.stringify({ ok:true, automacoes:[] });
    
    var dados = aba.getDataRange().getValues();
    var automacoes = [];
    
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) === String(idGrupo)) {
        var config = JSON.parse(String(dados[i][2]));
        automacoes.push({
          tipo: String(dados[i][1]),
          config: config,
          status: String(dados[i][3]),
          dataCriacao: String(dados[i][4])
        });
      }
    }
    
    return JSON.stringify({ ok:true, automacoes:automacoes });
  } catch(e) {
    Logger.log('Erro em listarAutomacoesGrupo: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message, automacoes:[] });
  }
}

function desativarAutomacao(idGrupo, tipo) {
  try {
    var trava = LockService.getScriptLock();
    try {
      trava.waitLock(6000);
      
      var aba = obterAbaPorNome(ABA_AUTOMACAO);
      if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada.' });
      
      var dados = aba.getDataRange().getValues();
      for (var i = 1; i < dados.length; i++) {
        if (String(dados[i][0]) === String(idGrupo) && String(dados[i][1]) === String(tipo)) {
          aba.getRange(i + 1, 3).setValue('INATIVA');
          SpreadsheetApp.flush();
          return JSON.stringify({ ok:true });
        }
      }
      
      return JSON.stringify({ ok:false, erro:'Automação não encontrada.' });
    } finally {
      trava.releaseLock();
    }
  } catch(e) {
    Logger.log('Erro em desativarAutomacao: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function _obterUltimaMensagemPrivada(idConversa) {
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (!aba) return null;
    
    var total = aba.getLastRow();
    if (total < 2) return null;
    
    // Otimização: ler apenas as últimas 100 linhas em vez da planilha inteira
    var maxLinhas = 100;
    var inicio = Math.max(1, total - maxLinhas);
    var numLinhas = total - inicio;
    
    if (numLinhas <= 0) return null;
    
    var dados = aba.getRange(inicio + 1, 1, numLinhas, 12).getValues();
    var ultima = null;
    var maxTs = 0;
    
    for (var i = 0; i < dados.length; i++) {
      if (String(dados[i][0]) === idConversa) {
        var ts = parseInt(dados[i][7]) || 0;
        if (ts > maxTs && String(dados[i][8]) !== 'APAGADA') {
          maxTs = ts;
          // Usar textoOriginal (coluna 11) se disponível, senão usar mensagem (coluna 3)
          var texto = String(dados[i][11] || dados[i][3]);
          ultima = {
            mensagem: texto,
            textoOriginal: texto,
            data: String(dados[i][4]),
            hora: String(dados[i][5]),
            ts: ts,
            remetente: String(dados[i][2])
          };
        }
      }
    }
    
    return ultima;
  } catch(e) {
    return null;
  }
}

function _obterNomeUsuario(email) {
  Logger.log('_obterNomeUsuario chamado para email: ' + email);
  try {
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) {
      Logger.log('Aba de usuários não encontrada, retornando email como nome');
      // Extrair nome do email (parte antes do @)
      var nome = email.split('@')[0];
      // Converter para formato de nome (primeira letra maiúscula)
      nome = nome.charAt(0).toUpperCase() + nome.slice(1);
      return nome;
    }

    var dados = aba.getDataRange().getValues();
    Logger.log('Total de usuários na aba: ' + dados.length);
    Logger.log('Emails na aba: ' + dados.map(function(r){ return r[0]; }).join(', '));
    for (var i = 1; i < dados.length; i++) {
      var emailNaAba = String(dados[i][0]||'').toLowerCase().trim();
      var emailBusca = email.toLowerCase().trim();
      Logger.log('Comparando: ' + emailNaAba + ' com ' + emailBusca);
      if (emailNaAba === emailBusca) {
        var nome = String(dados[i][1]||email);
        Logger.log('Usuário encontrado: ' + nome);
        return nome;
      }
    }
    Logger.log('Usuário não encontrado na aba, retornando email como nome');
    // Extrair nome do email (parte antes do @)
    var nome = email.split('@')[0];
    // Converter para formato de nome (primeira letra maiúscula)
    nome = nome.charAt(0).toUpperCase() + nome.slice(1);
    return nome;
  } catch(e) {
    Logger.log('Erro em _obterNomeUsuario: ' + e.message);
    // Extrair nome do email (parte antes do @)
    var nome = email.split('@')[0];
    // Converter para formato de nome (primeira letra maiúscula)
    nome = nome.charAt(0).toUpperCase() + nome.slice(1);
    return nome;
  }
}

// ── STATUS DE MENSAGEM (StatusMensagem.gs) ─────────────────

// ── Atualizar status de mensagem ───────────────────────────
function atualizarStatusMensagem(idMensagem, novoStatus, emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em || !idMensagem) return JSON.stringify({ ok:false, erro:'Parâmetros inválidos.' });
  
  var statusValidos = ['ENVIADA', 'ENTREGUE', 'LIDA', 'FALHOU'];
  if (statusValidos.indexOf(novoStatus) === -1) {
    return JSON.stringify({ ok:false, erro:'Status inválido.' });
  }
  
  try {
    var trava = LockService.getScriptLock();
    trava.waitLock(4000);
    
    // Verificar se é mensagem de grupo ou privada
    var abaGrupo = obterAbaPorNome(ABA_MENSAGENS);
    var abaPrivada = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    
    var encontrada = false;
    var aba = null;
    var linha = -1;
    
    // Buscar em mensagens de grupo
    if (abaGrupo) {
      var dados = abaGrupo.getDataRange().getValues();
      for (var i = 1; i < dados.length; i++) {
        if (String(dados[i][6]) === idMensagem) {
          aba = abaGrupo;
          linha = i + 1;
          encontrada = true;
          break;
        }
      }
    }
    
    // Buscar em mensagens privadas se não encontrou
    if (!encontrada && abaPrivada) {
      var dadosPriv = abaPrivada.getDataRange().getValues();
      for (var j = 1; j < dadosPriv.length; j++) {
        if (String(dadosPriv[j][6]) === idMensagem) {
          aba = abaPrivada;
          linha = j + 1;
          encontrada = true;
          break;
        }
      }
    }
    
    if (!encontrada) {
      return JSON.stringify({ ok:false, erro:'Mensagem não encontrada.' });
    }
    
    // Atualizar status
    aba.getRange(linha, 9).setValue(novoStatus);
    SpreadsheetApp.flush();
    
    // Invalidar cache
    if (aba === abaGrupo) {
      var canal = String(aba.getRange(linha, 4).getValue());
      CacheService.getScriptCache().remove(ckMsgs(canal));
    } else {
      var idConv = String(aba.getRange(linha, 1).getValue());
      CacheService.getScriptCache().remove(ckMensagensPrivadas(idConv));
    }
    
    return JSON.stringify({ ok:true, status:novoStatus });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Marcar mensagens como entregues para um usuário (batch eficiente) ──────
// Chamado quando o usuário abre/acessa o grupo — marca ENTREGUE para ele
function marcarComoEntregue(idGrupo, emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em || !idGrupo) return JSON.stringify({ ok:false });

  // Debounce: só executar 1x por usuário/grupo a cada 30s
  var ck = 'entregue_' + idGrupo + '_' + em.replace(/[^a-z0-9]/g,'_');
  if (CacheService.getScriptCache().get(ck)) return JSON.stringify({ ok:true, atualizadas:0, cached:true });
  CacheService.getScriptCache().put(ck, '1', 30);

  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba || aba.getLastRow() < 2) return JSON.stringify({ ok:true, atualizadas:0 });

    var dados = aba.getDataRange().getValues();
    var linhas = [];
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][3]||'').trim() !== idGrupo) continue;
      // Não marcar próprias mensagens (comparar email do remetente)
      // Como col[2] = nome, precisamos pular se for o próprio usuário
      var status = String(dados[i][9]||'ENVIADA').toUpperCase();
      if (status === 'ENVIADA') linhas.push(i+1);
    }
    if (linhas.length > 0) {
      // Batch write em lotes para não exceder limites
      linhas.forEach(function(l){ aba.getRange(l, 10).setValue('ENTREGUE'); });
      SpreadsheetApp.flush();
      _invalidarCacheMsgs(idGrupo);
    }
    return JSON.stringify({ ok:true, atualizadas:linhas.length });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Marcar mensagens como lidas pelo usuário + calcular status correto ──────
// ENTREGUE = ao menos 1 membro leu  |  LIDA = TODOS os membros leram
function marcarComoLidaStatus(idGrupo, emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em || !idGrupo) return JSON.stringify({ ok:false });

  // Debounce: só executar 1x por usuário/grupo a cada 15s
  var ck = 'lida_st_' + idGrupo + '_' + em.replace(/[^a-z0-9]/g,'_');
  if (CacheService.getScriptCache().get(ck)) return JSON.stringify({ ok:true, atualizadas:0, cached:true });
  CacheService.getScriptCache().put(ck, '1', 15);

  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba || aba.getLastRow() < 2) return JSON.stringify({ ok:true, atualizadas:0 });

    // ── 1. Obter lista de membros do grupo ──────────────────────────────────
    var abaGrupos = obterAbaPorNome(ABA_GRUPOS);
    var membrosEmails = [];   // emails dos membros
    var membrosNomes  = [];   // nomes resolvidos (lowercase)
    var ehGrupoTodos  = false;

    if (abaGrupos) {
      var dadosG = abaGrupos.getDataRange().getValues();
      for (var g = 1; g < dadosG.length; g++) {
        if (String(dadosG[g][0]||'').trim() !== idGrupo) continue;
        var membStr = String(dadosG[g][5]||'');
        ehGrupoTodos = membStr.toLowerCase() === 'todos';
        if (!ehGrupoTodos) {
          membrosEmails = membStr.replace(/;/g,',').split(',')
            .map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
        }
        break;
      }
    }

    // Resolver emails dos membros para comparar com a coluna Leitores (que agora armazena emails)
    if (!ehGrupoTodos && membrosEmails.length > 0) {
      membrosNomes = membrosEmails.map(function(x){ return x.toLowerCase(); });
    }

    // ── 2. Obter nome do usuário atual para adicionar aos Leitores ──────────
    var nomeAtual = '';
    var nomeRes = _resolverNomesMembros([em]);
    if (nomeRes && nomeRes.length > 0) nomeAtual = String(nomeRes[0].nome||nomeRes[0].email||'').trim();

    // ── 3. Ler últimas 200 mensagens e calcular status ──────────────────────
    var total = aba.getLastRow();
    var inicio = Math.max(2, total - 200);
    var numLinhas = total - inicio + 1;
    if (numLinhas <= 0) return JSON.stringify({ ok:true, atualizadas:0 });

    var dados = aba.getRange(inicio, 1, numLinhas, 10).getValues();
    var atualizacoes = [];

    for (var i = 0; i < dados.length; i++) {
      if (String(dados[i][3]||'').trim() !== idGrupo) continue;

      var statusAtual = String(dados[i][9]||'ENVIADA').toUpperCase();
      if (statusAtual === 'LIDA' || statusAtual === 'APAGADA') continue; // já no estado final

      var remetenteNome = String(dados[i][2]||'').trim().toLowerCase();
      // Resolver email do remetente para comparação com leitores (que agora usa emails)
      var remetenteEmail = remetenteNome;
      try {
        var remetenteRes = _resolverNomesMembros([remetenteNome]);
        if (remetenteRes && remetenteRes.length > 0) {
          remetenteEmail = String(remetenteRes[0].email||remetenteRes[0].nome||remetenteNome).toLowerCase();
        }
      } catch(e){}
      
      var leitoresStr = String(dados[i][5]||'').trim();
      var leitoresList = leitoresStr
        ? leitoresStr.split(',').map(function(x){ return x.trim().toLowerCase(); })
        : [];

      // Adicionar usuário atual aos leitores (por email, que é único)
      var novoLeitores = leitoresStr;
      if (em && leitoresList.indexOf(em.toLowerCase()) === -1) {
        novoLeitores  = leitoresStr ? leitoresStr + ',' + em : em;
        leitoresList.push(em.toLowerCase());
      }

      // ── Calcular novo statusMsg ─────────────────────────────────────────
      var novoStatus = statusAtual;

      if (ehGrupoTodos) {
        // Grupo aberto ("todos"): sem lista fechada → ENTREGUE quando ao menos 1 leu
        if (leitoresList.some(function(l){ return l !== remetenteEmail; })) {
          novoStatus = 'ENTREGUE';
        }
      } else if (membrosNomes.length > 0) {
        // Grupo com membros específicos → LIDA somente quando TODOS leram
        var memsSemRem = membrosNomes.filter(function(n){ return n !== remetenteEmail; });
        if (memsSemRem.length === 0) {
          novoStatus = 'LIDA'; // só o remetente no grupo
        } else {
          var leram = memsSemRem.filter(function(n){
            return leitoresList.indexOf(n) !== -1;
          }).length;
          if (leram >= memsSemRem.length) {
            novoStatus = 'LIDA';
          } else if (leram > 0) {
            novoStatus = 'ENTREGUE';
          }
        }
      } else {
        // Sem info de membros: fallback — ENTREGUE quando ao menos 1 leu
        if (leitoresList.some(function(l){ return l !== remetenteEmail; })) {
          novoStatus = 'ENTREGUE';
        }
      }

      var statusMudou  = novoStatus !== statusAtual;
      var leitoresMudou = novoLeitores !== leitoresStr;

      if (statusMudou || leitoresMudou) {
        atualizacoes.push({
          linha:        inicio + i,
          novoLeitores: leitoresMudou ? novoLeitores : null,
          novoStatus:   statusMudou   ? novoStatus   : null
        });
      }
    }

    // ── 4. Aplicar atualizações em batch ────────────────────────────────────
    if (atualizacoes.length > 0) {
      atualizacoes.forEach(function(upd) {
        if (upd.novoLeitores !== null) aba.getRange(upd.linha, 6).setValue(upd.novoLeitores);
        if (upd.novoStatus   !== null) aba.getRange(upd.linha, 10).setValue(upd.novoStatus);
      });
      SpreadsheetApp.flush();
      _invalidarCacheMsgs(idGrupo);
    }

    return JSON.stringify({ ok:true, atualizadas:atualizacoes.length });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}


// ── Obter contagem de mensagens não lidas ───────────────────
function obterNaoLidas(emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ total:0, porGrupo:{} });
  
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ total:0, porGrupo:{} });
    
    var dados = aba.getDataRange().getValues();
    var porGrupo = {};
    var total = 0;
    
    for (var i = 1; i < dados.length; i++) {
      var grupo = String(dados[i][3]);
      var status = String(dados[i][9]||'ENVIADA');
      var leitores = String(dados[i][5]||'');
      
      // Verificar se usuário já leu (por email, que é único)
      var leu = leitores.toLowerCase().indexOf(em.toLowerCase()) !== -1;
      
      if (!leu && status !== 'APAGADA') {
        if (!porGrupo[grupo]) porGrupo[grupo] = 0;
        porGrupo[grupo]++;
        total++;
      }
    }
    
    // Adicionar mensagens privadas não lidas
    var abaPriv = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (abaPriv) {
      var dadosPriv = abaPriv.getDataRange().getValues();
      var privadasNaoLidas = 0;
      
      for (var j = 1; j < dadosPriv.length; j++) {
        var remetente = String(dadosPriv[j][1]);
        var status = String(dadosPriv[j][8]||'ENVIADA');
        
        if (remetente !== em && status !== 'APAGADA' && status !== 'LIDA') {
          privadasNaoLidas++;
        }
      }
      
      if (privadasNaoLidas > 0) {
        porGrupo['privadas'] = privadasNaoLidas;
        total += privadasNaoLidas;
      }
    }
    
    return JSON.stringify({ total:total, porGrupo:porGrupo });
  } catch(e) {
    return JSON.stringify({ total:0, porGrupo:{} });
  }
}

// ── RESPOSTA DE MENSAGEM (RespostaMensagem.gs) ─────────────

function salvarRespostaMensagem(seuNome, mensagem, idMsgOriginal, emailUsuario) {
  var trava = LockService.getScriptLock();
  try {
    if (!trava.tryLock(6000)) return 'Erro: Sistema ocupado.';
    var em = normalizarEmail(emailUsuario);
    if (em) {
      var blk = JSON.parse(verificarUsuarioBloqueado(em));
      if (blk.bloqueado) return 'Erro: Conta bloqueada.';
    }
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return 'Erro: Aba não encontrada.';
    var dados = aba.getDataRange().getValues();
    var linhaOrig = -1, msgOrig = '', remOrig = '', destOrig = '';
    for (var i = 1; i < dados.length; i++) {
      var idL = String(dados[i][6]||'').trim();
      if (idL === idMsgOriginal || String(i+1) === idMsgOriginal) {
        linhaOrig = i+1; msgOrig = String(dados[i][4]||'').trim();
        remOrig   = String(dados[i][2]||'').trim(); destOrig = String(dados[i][3]||'').trim(); break;
      }
    }
    if (linhaOrig === -1) return 'Erro: Mensagem original não encontrada.';
    var msgLimpa = String(mensagem||'').trim();
    if (!msgLimpa || msgLimpa.length > MAX_TAMANHO_MSG) return 'Erro: Mensagem inválida.';
    
    // Sanitizar mensagem para XSS protection
    msgLimpa = sanitizarMensagem(msgLimpa);
    
    // ── Verificar moderação automática ─────────────────────────
    var modAuto = JSON.parse(verificarModeracaoAuto(destOrig, msgLimpa, em));
    if (!modAuto.permitido) {
      return 'Erro: Mensagem bloqueada pela moderação automática (palavra: ' + (modAuto.palavra || '') + ').';
    }
    
    // Processar links para HTML clicável
    var msgComLinks = processarLinks(msgLimpa);
    
    var now = new Date(), tz = Session.getScriptTimeZone(), id = Utilities.getUuid();
    var nm  = String(seuNome||'Visitante').trim();
    aba.appendRow([
      Utilities.formatDate(now,tz,'dd/MM/yyyy'), Utilities.formatDate(now,tz,'HH:mm:ss'),
      nm, destOrig, msgComLinks, nm, id, '{}', '', 'ATIVA', idMsgOriginal, msgOrig, '', ''
    ]);
    SpreadsheetApp.flush();
    // Adicionar na fila do cache para que o poll do remetente encontre a mensagem
    var ts = now.getTime();
    _adicionarNaFila(destOrig, {
      idUnico: aba.getLastRow(), idMsg: id,
      data: Utilities.formatDate(now,tz,'dd/MM/yyyy'), hora: Utilities.formatDate(now,tz,'HH:mm:ss'),
      ts: ts, remetente: nm, destinatario: destOrig,
      mensagem: msgComLinks, textoOriginal: msgOrig,
      reacoes: '{}', editada: '', statusMsg: 'ENVIADA',
      idRespondida: idMsgOriginal, mencoes: [], arquivo: ''
    });
    _invalidarCacheMsgs(destOrig);
    try { registrarAtividade(nm, emailUsuario); } catch(x){}
    try { registrarLogSistema('CHAT', nm, 'Reply', 'Para:'+remOrig); } catch(x){}
    // Retornar UUID para que o frontend faça substituição da temporária sem poll
    return JSON.stringify({ ok:true, idMensagem:id, ts:ts });
  } catch(e) { return 'Erro: ' + e.message; }
  finally   { if (trava.hasLock()) trava.releaseLock(); }
}

function obterContextoMensagem(idMsg) {
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ encontrado:false });
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      var idL = String(dados[i][6]||'').trim();
      if (idL === idMsg || String(i+1) === idMsg) {
        return JSON.stringify({
          encontrado: true, idUnico:i+1, idMsg:idL||'R'+(i+1),
          data:dados[i][0], hora:dados[i][1], remetente:String(dados[i][2]).trim(),
          destinatario:String(dados[i][3]).trim(), mensagem:String(dados[i][4]).trim()
        });
      }
    }
    return JSON.stringify({ encontrado:false });
  } catch(e) { return JSON.stringify({ encontrado:false }); }
}

// ── ENCAMINHAMENTO (Encaminhamento.gs) ─────────────────────

// ── Encaminhar mensagem ─────────────────────────────────────
function encaminharMensagem(idMensagemOriginal, destino, nomeRemetente, emailUsuario, mensagemAdicional) {
  var em = normalizarEmail(emailUsuario);
  if (!em || !idMensagemOriginal || !destino) {
    return JSON.stringify({ ok:false, erro:'Parâmetros inválidos.' });
  }
  
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(6000);
    
    // Verificar se usuário está bloqueado
    var blk = JSON.parse(verificarUsuarioBloqueado(em));
    if (blk.bloqueado) return JSON.stringify({ ok:false, erro:'Conta bloqueada.' });
    
    // Buscar mensagem original
    var msgOriginal = _obterMensagemOriginal(idMensagemOriginal);
    if (!msgOriginal) {
      return JSON.stringify({ ok:false, erro:'Mensagem original não encontrada.' });
    }
    
    // Verificar permissão (pode encaminhar se foi você quem enviou ou se está no grupo)
    var podeEncaminhar = _verificarPermissaoEncaminhar(msgOriginal, em);
    if (!podeEncaminhar) {
      return JSON.stringify({ ok:false, erro:'Sem permissão para encaminhar esta mensagem.' });
    }
    
    var now = new Date();
    var tz = Session.getScriptTimeZone();
    var id = Utilities.getUuid();
    var dataS = Utilities.formatDate(now, tz, 'dd/MM/yyyy');
    var horaS = Utilities.formatDate(now, tz, 'HH:mm:ss');
    var ts = now.getTime();
    
    // Verificar se destino é conversa privada ou grupo
    var ehPrivada = destino.indexOf('dm_') === 0;
    
    if (ehPrivada) {
      // Encaminhar para conversa privada
      var abaPriv = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
      if (!abaPriv) return JSON.stringify({ ok:false, erro:'Aba de mensagens privadas não encontrada.' });
      
      // Formato rico: ➫FWD❪autor❪texto_original➫ + mensagem adicional opcional
      // O texto original JÁ veio sanitizado da planilha — não re-sanitizar
      var textoOriginal = msgOriginal.mensagem;
      var msgEncaminhada = '\u27AB FWD\u27AA' + msgOriginal.remetente + '\u27AA' + textoOriginal + '\u27AB';
      if (mensagemAdicional && mensagemAdicional.trim()) {
        msgEncaminhada = msgEncaminhada + '\n' + sanitizarMensagem(mensagemAdicional.trim());
      }
      
      abaPriv.appendRow([
        destino,
        em,
        nomeRemetente,
        msgEncaminhada,
        dataS,
        horaS,
        id,
        ts,
        'ENVIADA',
        '{}',
        '',
        msgOriginal.mensagem
      ]);
      
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckMensagensPrivadas(destino));
      
      // Notificar destinatário
      var emails = destino.replace('dm_', '').split('_');
      var outroEmail = emails[0] === em ? emails[1] : emails[0];
      _notificarUsuarioEncaminhamento(outroEmail, nomeRemetente);
      
    } else {
      // Encaminhar para grupo
      var abaGrupo = obterAbaPorNome(ABA_MENSAGENS);
      if (!abaGrupo) return JSON.stringify({ ok:false, erro:'Aba de mensagens não encontrada.' });
      
      // Formato rico: ➫FWD❪autor❪texto_original➫ + mensagem adicional opcional
      // O texto original JÁ veio sanitizado da planilha — não re-sanitizar
      var textoOriginal = msgOriginal.mensagem;
      var msgEncaminhada = '\u27AB FWD\u27AA' + msgOriginal.remetente + '\u27AA' + textoOriginal + '\u27AB';
      if (mensagemAdicional && mensagemAdicional.trim()) {
        msgEncaminhada = msgEncaminhada + '\n' + sanitizarMensagem(mensagemAdicional.trim());
      }
      
      // Extrair menções da mensagem adicional
      var mencoes = extrairMencoes(msgEncaminhada);
      
      abaGrupo.appendRow([
        dataS,
        horaS,
        nomeRemetente,
        destino,
        msgEncaminhada,
        nomeRemetente,
        id,
        '{}',
        '',
        'ENVIADA',
        '',
        msgOriginal.mensagem,
        mencoes.join(','),
        msgOriginal.arquivo || ''
      ]);
      
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckMsgs(destino));
    }
    
    registrarLogSistema('ENCAMINHAMENTO', nomeRemetente, 'Mensagem encaminhada', 'Para:' + destino);
    
    return JSON.stringify({ ok:true, idMensagem:id });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Obter mensagem original para encaminhamento ─────────────
function _obterMensagemOriginal(idMensagem) {
  try {
    // Buscar em mensagens de grupo
    var abaGrupo = obterAbaPorNome(ABA_MENSAGENS);
    if (abaGrupo) {
      var dados = abaGrupo.getDataRange().getValues();
      for (var i = 1; i < dados.length; i++) {
        if (String(dados[i][6]) === idMensagem) {
          return {
            id: String(dados[i][6]),
            mensagem: String(dados[i][4]),
            remetente: String(dados[i][2]),
            destinatario: String(dados[i][3]),
            data: String(dados[i][0]),
            hora: String(dados[i][1]),
            mencoes: String(dados[i][12]||'').split(',').filter(Boolean),
            arquivo: String(dados[i][13]||''),
            tipo: 'grupo'
          };
        }
      }
    }
    
    // Buscar em mensagens privadas
    var abaPriv = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
    if (abaPriv) {
      var dadosPriv = abaPriv.getDataRange().getValues();
      for (var j = 1; j < dadosPriv.length; j++) {
        if (String(dadosPriv[j][6]) === idMensagem) {
          return {
            id: String(dadosPriv[j][6]),
            mensagem: String(dadosPriv[j][3]),
            remetente: String(dadosPriv[j][2]),
            destinatario: String(dadosPriv[j][1]),
            data: String(dadosPriv[j][4]),
            hora: String(dadosPriv[j][5]),
            mencoes: [],
            arquivo: '',
            tipo: 'privada'
          };
        }
      }
    }
    
    return null;
  } catch(e) {
    return null;
  }
}

// ── Verificar permissão para encaminhar ───────────────────────
function _verificarPermissaoEncaminhar(msgOriginal, emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  
  // Remetente original sempre pode encaminhar
  if (msgOriginal.remetente.toLowerCase() === em.toLowerCase()) return true;
  
  if (msgOriginal.tipo === 'grupo') {
    // Verificar se está no grupo sem depender de função inexistente
    try {
      var grupos = JSON.parse(_listarTodosGruposRaw());
      var dest = String(msgOriginal.destinatario||'');
      for (var i = 0; i < grupos.length; i++) {
        if (String(grupos[i].id) !== dest) continue;
        var membros = String(grupos[i].membros||'').toLowerCase();
        if (membros === 'todos') return true;
        return membros.split(',').map(function(x){ return x.trim(); }).indexOf(em) !== -1;
      }
    } catch(x){}
    return false;
  }
  
  if (msgOriginal.tipo === 'privada') {
    // Para DM: verificar se o email do usuário faz parte da conversa
    // O ID da conversa tem formato dm_email1_email2 (ambos emails)
    // A forma mais confiável é verificar na aba ConversasPrivadas
    try {
      var abaConv = obterAbaPorNome(ABA_CONVERSAS_PRIVADAS);
      if (!abaConv) return false;
      // Buscar o idConversa a partir do idMensagem
      var abaMsgPriv = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
      if (!abaMsgPriv) return false;
      var dadosMp = abaMsgPriv.getDataRange().getValues();
      var idConversa = '';
      for (var j = 1; j < dadosMp.length; j++) {
        if (String(dadosMp[j][6]) === msgOriginal.id) { idConversa = String(dadosMp[j][0]); break; }
      }
      if (!idConversa) return false;
      var dadosConv = abaConv.getDataRange().getValues();
      for (var k = 1; k < dadosConv.length; k++) {
        if (String(dadosConv[k][0]) !== idConversa) continue;
        return String(dadosConv[k][1]).toLowerCase() === em ||
               String(dadosConv[k][3]).toLowerCase() === em;
      }
    } catch(x){}
    return false;
  }
  
  return false;
}

// ── Notificar usuário sobre encaminhamento ───────────────────
function _notificarUsuarioEncaminhamento(emailUsuario, nomeRemetente) {
  // Não usa a tabela global de notificações para não interferir com notificações do admin.
  // O destinatário verá a mensagem ao fazer o próximo poll — sem ação adicional necessária.
  try {
    registrarLogSistema('DM', nomeRemetente, 'Mensagem encaminhada', 'Para:' + emailUsuario);
  } catch(e) {}
}

// ── Listar mensagens recentes para encaminhar ───────────────
function listarMensagensRecentesParaEncaminhar(emailUsuario, limite) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  
  try {
    var max = limite || 50;
    var mensagens = [];
    
    // Buscar em grupos que o usuário participa
    var grupos = JSON.parse(listarGruposUsuario(em));
    if (grupos.ok && grupos.grupos) {
      grupos.grupos.forEach(function(g) {
        var aba = obterAbaPorNome(ABA_MENSAGENS);
        if (!aba) return;
        
        var dados = aba.getDataRange().getValues();
        var count = 0;
        
        for (var i = dados.length - 1; i >= 1 && count < 5; i--) {
          if (String(dados[i][3]) === g.id && String(dados[i][9]) !== 'APAGADA') {
            mensagens.push({
              id: String(dados[i][6]),
              mensagem: String(dados[i][4]),
              remetente: String(dados[i][2]),
              grupo: g.nome,
              data: String(dados[i][0]),
              hora: String(dados[i][5]),
              tipo: 'grupo'
            });
            count++;
          }
        }
      });
    }
    
    // Buscar em conversas privadas
    var convs = JSON.parse(listarConversasPrivadas(em));
    if (convs.ok && convs.conversas) {
      convs.conversas.forEach(function(c) {
        var aba = obterAbaPorNome(ABA_MENSAGENS_PRIVADAS);
        if (!aba) return;
        
        var dados = aba.getDataRange().getValues();
        var count = 0;
        
        for (var i = dados.length - 1; i >= 1 && count < 3; i--) {
          if (String(dados[i][0]) === c.idConversa && String(dados[i][8]) !== 'APAGADA') {
            mensagens.push({
              id: String(dados[i][6]),
              mensagem: String(dados[i][3]),
              remetente: String(dados[i][2]),
              grupo: c.outroNome,
              data: String(dados[i][4]),
              hora: String(dados[i][5]),
              tipo: 'privada'
            });
            count++;
          }
        }
      });
    }
    
    // Ordenar por data (mais recentes primeiro)
    mensagens.sort(function(a, b) {
      return new Date(b.data + ' ' + b.hora) - new Date(a.data + ' ' + a.hora);
    });
    
    // Limitar resultado
    if (mensagens.length > max) {
      mensagens = mensagens.slice(0, max);
    }
    
    return JSON.stringify({ ok:true, mensagens:mensagens });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}
