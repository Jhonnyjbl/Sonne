// ============================================================
// UtilitariosValidacoes.gs — Helpers e Validações (Consolidado)
// Consolidado de: Utilitarios.gs + Validacoes.gs
// ============================================================

// ── UTILITÁRIOS (Utilitarios.gs) ─────────────────────────────

function normalizarEmail(email) {
  var v = String(email || '').toLowerCase().trim();
  if (!v || v === 'pendente') return '';
  var at = v.indexOf('@'), dot = v.lastIndexOf('.');
  if (at < 1 || dot < at + 2 || dot >= v.length - 1) return '';
  return v;
}

function gerarIdMsg() { return Utilities.getUuid(); }

function sanitizarTexto(t) {
  return String(t || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Sanitização avançada para mensagens (XSS protection)
function sanitizarMensagem(texto) {
  if (!texto) return '';
  var t = String(texto);
  
  // Preservar formatos especiais de imagem/arquivo antes da sanitização
  var placeholders = [];
  t = t.replace(/(\[imagem:[^\]]+\]|\[Arquivo:[^\]]+\]\|\|\|[a-zA-Z0-9_-]+)/gi, function(match) {
    var idx = placeholders.length;
    placeholders.push(match);
    return '__PLACEHOLDER_' + idx + '__';
  });
  
  // Remove tags HTML perigosas mas permite formatação básica
  t = t.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  t = t.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  t = t.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
  t = t.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '');
  t = t.replace(/javascript:/gi, '');
  t = t.replace(/on\w+\s*=/gi, '');
  
  // Sanitiza caracteres especiais
  t = sanitizarTexto(t);
  
  // Restaurar formatos especiais preservados
  t = t.replace(/__PLACEHOLDER_(\d+)__/g, function(match, idx) {
    return placeholders[parseInt(idx)];
  });
  
  return t;
}

// Detecta menções em texto (@usuario)
function extrairMencoes(texto) {
  var mencoes = [];
  if (!texto) return mencoes;
  var regex = /@([a-zA-Z0-9_\-\s]+)/g;
  var match;
  while ((match = regex.exec(texto)) !== null) {
    mencoes.push(match[1].trim());
  }
  return mencoes;
}

// Processa texto para destacar menções
function processarMencoes(texto, usuariosMap) {
  if (!texto) return texto;
  var t = String(texto);
  var regex = /@([a-zA-Z0-9_\-\s]+)/g;
  return t.replace(regex, function(match, nome) {
    var nomeLimpo = nome.trim();
    if (usuariosMap[nomeLimpo.toLowerCase()]) {
      return '<span class="mention-tag">@' + nomeLimpo + '</span>';
    }
    return match;
  });
}

// Formatação de texto estilo WhatsApp
function formatarTextoWhatsApp(texto) {
  if (!texto) return texto;
  var t = String(texto);
  // Negrito: *texto*
  t = t.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
  // Itálico: _texto_
  t = t.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Monospace: ```texto```
  t = t.replace(/```([^`]+)```/g, '<code>$1</code>');
  // Tachado: ~texto~
  t = t.replace(/~([^~]+)~/g, '<del>$1</del>');
  return t;
}

// Detecta links no texto
function extrairLinks(texto) {
  var links = [];
  if (!texto) return links;
  var regex = /(https?:\/\/[^\s]+)/g;
  var match;
  while ((match = regex.exec(texto)) !== null) {
    links.push(match[1]);
  }
  return links;
}

// Converte links para HTML clicável
function processarLinks(texto) {
  if (!texto) return texto;
  var t = String(texto);
  var regex = /(\[imagem:[^\]]+\])|(\[Arquivo:[^\]]+\])|(https?:\/\/[^\s]+)/gi;
  return t.replace(regex, function(match, img, arq, url) {
    if (img || arq) return match;
    var trailing = '';
    var matchTrailing = url.match(/([.,;:!?)\]]+)$/);
    if (matchTrailing) {
      trailing = matchTrailing[1];
      url = url.slice(0, -trailing.length);
    }
    return '<a href="' + url + '" target="_blank" class="msg-link">' + url + '</a>' + trailing;
  });
}

function truncar(texto, max, suf) {
  if (!texto) return '';
  return texto.length <= max ? texto : texto.substring(0, max) + (suf || '...');
}

function formatarDataLog(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss');
  return String(v);
}

function parsearDataHoraMensagem(dataStr, horaStr) {
  try {
    if (!dataStr || !horaStr) return null;
    var d = dataStr.split('/'), h = horaStr.split(':');
    if (d.length !== 3 || h.length < 2) return null;
    return new Date(+d[2], +d[1]-1, +d[0], +h[0], +h[1], +(h[2]||0));
  } catch(e){ return null; }
}

function aplicarCabecalhoEAjustes(aba, headers, larguras) {
  var atual = aba.getLastRow() === 0 ? [] : aba.getRange(1,1,1,Math.max(headers.length, aba.getLastColumn())).getValues()[0];
  var alterado = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(atual[i]||'').trim() !== headers[i]) {
      aba.getRange(1, i+1).setValue(headers[i]);
      alterado = true;
    }
  }
  if (larguras) {
    for (var j = 0; j < larguras.length; j++) {
      aba.setColumnWidth(j+1, larguras[j]);
    }
  }
  return alterado;
}

function formatarLinhaCabecalho(aba, numCols) {
  aba.getRange(1,1,1,numCols)
     .setFontWeight('bold')
     .setBackground('#00a884')
     .setFontColor('#ffffff')
     .setHorizontalAlignment('center');
}

function obterConfiguracao(chave) {
  var cache = CacheService.getScriptCache();
  var ck = ckConfig();
  var raw = cache.get(ck);
  var mapa = raw ? JSON.parse(raw) : null;
  if (!mapa) {
    mapa = {};
    var aba = obterAbaPorNome(ABA_CONFIG);
    if (aba) {
      var dados = aba.getDataRange().getValues();
      for (var i = 1; i < dados.length; i++) {
        mapa[String(dados[i][0]||'').trim()] = String(dados[i][1]||'');
      }
    }
    _cachePutSafe(cache, ck, JSON.stringify(mapa), CACHE_TTL_CONFIG);
  }
  return mapa[chave] !== undefined ? mapa[chave] : null;
}

function definirConfiguracao(chave, valor) {
  var aba = obterAbaPorNome(ABA_CONFIG);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_CONFIG);
    aplicarCabecalhoEAjustes(aba, obterEstruturaAbas().Config.headers, null);
    formatarLinhaCabecalho(aba, 3);
  }
  var dados = aba.getDataRange().getValues();
  for (var i = 1; i < dados.length; i++) {
    if (String(dados[i][0]||'').trim() === chave) {
      aba.getRange(i+1,2).setValue(valor);
      aba.getRange(i+1,3).setValue(new Date().toLocaleString());
      CacheService.getScriptCache().remove(ckConfig());
      return;
    }
  }
  aba.appendRow([chave, valor, new Date().toLocaleString()]);
  CacheService.getScriptCache().remove(ckConfig());
}

// ── VALIDAÇÕES (Validacoes.gs) ───────────────────────────────

function validarNomeDisponivel(nome, emailAtual) {
  var nm = String(nome||'').trim().toLowerCase();
  var em = normalizarEmail(emailAtual) || '';
  if (!nm)       return JSON.stringify({ disponivel:false, motivo:'Nome vazio.' });
  if (nm.length < 2)  return JSON.stringify({ disponivel:false, motivo:'Nome muito curto (mín. 2).' });
  if (nm.length > 40) return JSON.stringify({ disponivel:false, motivo:'Nome muito longo (máx. 40).' });
  var aba = obterAbaPorNome(ABA_USUARIOS);
  if (!aba) return JSON.stringify({ disponivel:true, motivo:'' });
  var dados = aba.getDataRange().getValues();
  for (var i = 1; i < dados.length; i++) {
    var nLinha = String(dados[i][1]||'').trim().toLowerCase();
    var eLinha = String(dados[i][0]||'').toLowerCase().trim();
    if (nLinha === nm && eLinha !== em)
      return JSON.stringify({ disponivel:false, motivo:'Nome já em uso.' });
  }
  return JSON.stringify({ disponivel:true, motivo:'' });
}

function validarMensagem(msg) {
  var m = String(msg||'').trim();
  if (!m) return { valid:false, motivo:'Mensagem vazia.' };
  if (m.length > MAX_TAMANHO_MSG) return { valid:false, motivo:'Muito longa (máx. '+MAX_TAMANHO_MSG+').' };
  return { valid:true, motivo:'' };
}

function validarNomeUsuario(nome) {
  var n = String(nome||'').trim();
  if (!n || n.length < 2)  return { valid:false, motivo:'Nome muito curto.' };
  if (n.length > 40)       return { valid:false, motivo:'Nome muito longo.' };
  return { valid:true, motivo:'' };
}

function validarSenhaAdmin(senha) { return String(senha) === getSenhaAdmin(); }
