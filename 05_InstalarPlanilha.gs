// ============================================================
// InstalarPlanilha.gs — Setup e Configuração da Planilha (Consolidado)
// Consolidado de: Instalar.gs + PlanilhaConfig.gs
// ============================================================

// ── INSTALAÇÃO (Instalar.gs) ─────────────────────────────────

function instalarSistemaCompleto() {
  Logger.log('=== INSTALAÇÃO ' + SISTEMA_NOME + ' v' + SISTEMA_VERSAO + ' ===');
  var etapas = [], erros = [], t0 = Date.now();

  _etapa('1/5 Estrutura da planilha', function() {
    configurarPlanilhaAutomatica(true);
  }, etapas, erros);

  _etapa('2/5 Grupo padrão', function() {
    criarGrupoPadrao();
  }, etapas, erros);

  _etapa('3/5 Cache', function() {
    limparCacheSistema();
    aquecerCache();
  }, etapas, erros);

  _etapa('4/5 Trigger', function() {
    criarTriggerProcessamentoFilas();
  }, etapas, erros);

  _etapa('5/5 Verificação', function() {
    var v = verificarSistemaCompleto();
    if (v.erros > 0) throw new Error(v.erros + ' componente(s) com problema.');
  }, etapas, erros);

  var tempo = ((Date.now()-t0)/1000).toFixed(1);
  etapas.forEach(function(e){ Logger.log(e); });
  if (erros.length) erros.forEach(function(e){ Logger.log('❌ ' + e); });
  Logger.log('Tempo: ' + tempo + 's | Erros: ' + erros.length);
  return { sucesso:erros.length===0, etapas:etapas.length, erros:erros.length, tempo:tempo };
}

function _etapa(descricao, fn, etapas, erros) {
  try { fn(); etapas.push('✅ ' + descricao); Logger.log('✅ ' + descricao); }
  catch(e) { erros.push(descricao + ': ' + e.message); Logger.log('❌ ' + descricao + ': ' + e.message); }
}

function criarTriggerProcessamentoFilas() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processarTodasFilas') { Logger.log('Trigger já existe.'); return; }
  }
  ScriptApp.newTrigger('processarTodasFilas').timeBased().everyMinutes(5).create();
  Logger.log('Trigger criado.');
}

function removerTriggerProcessamentoFilas() {
  var cnt = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processarTodasFilas') { ScriptApp.deleteTrigger(t); cnt++; }
  });
  Logger.log('Triggers removidos: ' + cnt);
  return cnt;
}

/** Chamado pelo trigger a cada 5 min */
function processarTodasFilas() {
  try {
    limparLogsAntigos(7);
  } catch(e) { Logger.log('processarTodasFilas erro: ' + e.message); }
}

function aquecerCache() {
  var c = CacheService.getScriptCache();
  c.put(ckStruct(), '1', CACHE_TTL_STRUCT);
  // Pré-carrega lista de grupos
  try { _listarTodosGruposRaw(); } catch(x){}
  Logger.log('Cache aquecido.');
}

// ── CONFIGURAÇÃO DA PLANILHA (PlanilhaConfig.gs) ─────────────

function configurarPlanilhaAutomatica(silencioso) {
  // Invalida cache de estrutura para forçar verificação completa
  // (necessário quando novas abas são adicionadas ao sistema)
  invalidarCacheEstrutura();

  var trava = LockService.getScriptLock();
  var relatorio;
  try {
    trava.waitLock(8000);
    relatorio = _configurarInterno(obterPlanilhaChat());
    SpreadsheetApp.flush();
    marcarEstruturaOk();
  } catch(e) {
    relatorio = { ok: false, erro: e.message };
    invalidarCacheEstrutura();
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
  return JSON.stringify(relatorio);
}

function garantirEstruturaPlanilha() {
  var planilha = obterPlanilhaChat();

  // Se cache diz OK, só verifica as abas críticas rapidamente
  // Se alguma estiver faltando, invalida cache e recria tudo
  if (estruturaEstaEmCache()) {
    if (!_verificarAbasCriticas(planilha)) {
      invalidarCacheEstrutura();
    } else {
      return planilha;
    }
  }

  _garantirMinimo(planilha);
  marcarEstruturaOk();
  return planilha;
}

// Verifica se todas as abas definidas em obterEstruturaAbas() existem
function _verificarAbasCriticas(planilha) {
  try {
    var est = obterEstruturaAbas();
    var nomes = Object.keys(est);
    for (var i = 0; i < nomes.length; i++) {
      if (!planilha.getSheetByName(nomes[i])) return false;
    }
    return true;
  } catch(e) { return false; }
}

function _configurarInterno(planilha) {
  var est = obterEstruturaAbas();
  var rel = { ok: true, versao: SISTEMA_VERSAO, criadas: [], atualizadas: [] };
  Object.keys(est).forEach(function(nome) {
    var r = _garantirAba(planilha, nome, est[nome]);
    if (r.criada)     rel.criadas.push(nome);
    if (r.atualizada) rel.atualizadas.push(nome);
  });
  _registrarConfig(planilha);
  _ordenarAbas(planilha, est);
  return rel;
}

function _garantirMinimo(planilha) {
  var est = obterEstruturaAbas();
  Object.keys(est).forEach(function(nome) {
    var cfg = est[nome];
    var aba = planilha.getSheetByName(nome);
    if (!aba) {
      _garantirAba(planilha, nome, cfg);
      return;
    }
    if (aba.getLastColumn() < cfg.headers.length) {
      aplicarCabecalhoEAjustes(aba, cfg.headers, null);
      formatarLinhaCabecalho(aba, cfg.headers.length);
    }
  });
}

function _garantirAba(planilha, nome, cfg) {
  var aba = planilha.getSheetByName(nome);
  var criada = false;
  if (!aba) { aba = planilha.insertSheet(nome); criada = true; }
  var atualizada = aplicarCabecalhoEAjustes(aba, cfg.headers, cfg.larguras);
  formatarLinhaCabecalho(aba, cfg.headers.length);
  if (nome === ABA_MENSAGENS) aba.setFrozenRows(1);
  if (nome === ABA_CONFIG && aba.getLastRow() < 2) {
    aba.appendRow(['VersaoApp', SISTEMA_VERSAO, new Date().toLocaleString()]);
    aba.appendRow(['PlanilhaConfigurada', 'sim', new Date().toLocaleString()]);
  }
  if (nome === ABA_LOGS && aba.getLastRow() < 2) {
    aba.appendRow([new Date(), 'SISTEMA', 'Sistema', 'Inicializacao', 'Logs criados']);
  }
  return { criada: criada, atualizada: atualizada };
}

function _registrarConfig(planilha) {
  var aba = planilha.getSheetByName(ABA_CONFIG);
  if (!aba) return;
  var agora = new Date().toLocaleString();
  _atualizarChaveConfig(aba, 'VersaoApp', SISTEMA_VERSAO, agora);
  _atualizarChaveConfig(aba, 'UltimaConfig', agora, agora);
  
  // Criar configuração de EmailAdmins se não existir
  var dados = aba.getDataRange().getValues();
  var existeEmailAdmins = false;
  var existeEmailModeradores = false;
  for (var i = 1; i < dados.length; i++) {
    var chave = String(dados[i][0]).trim();
    if (chave === 'EmailsAdmins') existeEmailAdmins = true;
    if (chave === 'EmailsModeradores') existeEmailModeradores = true;
  }
  if (!existeEmailAdmins) {
    aba.appendRow(['EmailsAdmins', '', agora]);
  }
  if (!existeEmailModeradores) {
    aba.appendRow(['EmailsModeradores', '', agora]);
  }
  
  CacheService.getScriptCache().remove(ckConfig());
}

function _atualizarChaveConfig(aba, chave, valor, quando) {
  var dados = aba.getDataRange().getValues();
  for (var i = 1; i < dados.length; i++) {
    if (String(dados[i][0]).trim() === chave) {
      aba.getRange(i+1,2).setValue(valor);
      aba.getRange(i+1,3).setValue(quando);
      return;
    }
  }
  aba.appendRow([chave, valor, quando]);
}

function _ordenarAbas(planilha, est) {
  var ordem = Object.keys(est)
    .map(function(n){ return { n:n, o:est[n].ordem }; })
    .sort(function(a,b){ return a.o - b.o; });
  ordem.forEach(function(item, idx) {
    var aba = planilha.getSheetByName(item.n);
    if (aba) { planilha.setActiveSheet(aba); planilha.moveActiveSheet(idx+1); }
  });
}

// ── Auto-reparo: chama na inicialização (doGet) ──────────
// Garante que TODAS as abas existam sem depender do cache
function autoRepararEstrutura() {
  try {
    var planilha = obterPlanilhaChat();
    var est = obterEstruturaAbas();
    var reparadas = [];
    Object.keys(est).forEach(function(nome) {
      var aba = planilha.getSheetByName(nome);
      if (!aba) {
        _garantirAba(planilha, nome, est[nome]);
        reparadas.push(nome);
      }
    });
    if (reparadas.length > 0) {
      SpreadsheetApp.flush();
      invalidarCacheEstrutura();
      registrarLogSistema('SISTEMA', 'AutoReparo', 'Abas criadas', reparadas.join(','));
    }
    return reparadas;
  } catch(e) {
    return [];
  }
}

// ── Limpeza de duplicados ─────────────────────────────────
function limparDuplicadosUsuarios() {
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(5000);
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada' });
    var dados = aba.getDataRange().getValues();
    var visto = {}, linhasApagar = [], removidas = 0;
    for (var i = 1; i < dados.length; i++) {
      var email = String(dados[i][0]||'').toLowerCase().trim();
      if (!email || email.indexOf('@') === -1) { linhasApagar.push(i+1); continue; }
      if (visto[email]) { linhasApagar.push(i+1); removidas++; }
      else visto[email] = true;
    }
    linhasApagar.sort(function(a,b){ return b-a; }).forEach(function(r){ aba.deleteRow(r); });
    CacheService.getScriptCache().remove(ckUsuarios());
    return JSON.stringify({ ok:true, removidas: removidas });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Verificação rápida ────────────────────────────────────
function verificacaoRapida() {
  try {
    var p = obterPlanilhaChat();
    if (!p) return false;
    // Verificar TODAS as abas definidas, não apenas as essenciais
    return _verificarAbasCriticas(p);
  } catch(e) { return false; }
}

function executarConfiguracaoInicial() {
  configurarPlanilhaAutomatica(true);
}
