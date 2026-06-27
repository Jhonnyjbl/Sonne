// ============================================================
// AdminSistema.gs — Funções Administrativas e Sistema (Consolidado)
// Consolidado de: Admin.gs + RateLimiting.gs + Logs.gs + VerificacaoSistema.gs
// ============================================================

// ── ADMIN (Admin.gs) ───────────────────────────────────────

function verificarSenhaAdmin(senha) { 
  var senhaAdmin = getSenhaAdmin();
  Logger.log('verificarSenhaAdmin chamado. Senha digitada: ' + senha + ', Senha admin: ' + senhaAdmin);
  var resultado = String(senha) === senhaAdmin;
  Logger.log('Resultado da verificação: ' + resultado);
  return resultado;
}

function verificarAdmin(email, senha) {
  Logger.log('verificarAdmin chamado para email: ' + email);
  var senhaCorreta = verificarSenhaAdmin(senha);
  Logger.log('Senha correta: ' + senhaCorreta);
  if (!senhaCorreta) {
    Logger.log('Senha incorreta, retornando erro');
    return JSON.stringify({ ok:false, erro:'Senha incorreta', isAdmin:false });
  }
  Logger.log('Senha correta, retornando ok:true');
  return JSON.stringify({ ok:true, isAdmin:true, email:email });
}

function verificarSeAdmin(email) {
  try {
    Logger.log('verificarSeAdmin chamado para email: ' + email);
    var lista = obterConfiguracao('EmailsAdmins') || '';
    Logger.log('Lista de admins da config: ' + lista);
    if (!lista) {
      Logger.log('Lista vazia, retornando false');
      return false;
    }
    var em = normalizarEmail(email);
    Logger.log('Email normalizado: ' + em);
    var resultado = lista.split(',').some(function(x){ return normalizarEmail(x) === em; });
    Logger.log('Resultado da verificação: ' + resultado);
    return resultado;
  } catch(e) {
    Logger.log('Erro em verificarSeAdmin: ' + e.message);
    return false;
  }
}

function verificarSeModerador(email) {
  try {
    // Primeiro tenta ler da aba Moderacao (nova estrutura)
    var planilha = obterPlanilhaChat();
    var abaModeracao = planilha.getSheetByName(ABA_MODERACAO);
    
    if (abaModeracao) {
      var dados = abaModeracao.getDataRange().getValues();
      var emailNorm = normalizarEmail(email);
      
      for (var i = 1; i < dados.length; i++) {
        var status = String(dados[i][2] || '').toUpperCase();
        if (status === 'ATIVO' && normalizarEmail(dados[i][0]) === emailNorm) {
          return true;
        }
      }
    }
    
    // Fallback: ler da configuração antiga (aba Config)
    var lista = obterConfiguracao('EmailsModeradores') || '';
    if (!lista) return false;
    var em = normalizarEmail(email);
    return lista.split(',').some(function(x){ return normalizarEmail(x) === em; });
    
  } catch(e) { return false; }
}

function verificarAdminOuModerador(email) {
  return verificarSeAdmin(email) || verificarSeModerador(email);
}

// ── Gerenciar Moderadores ─────────────────────────────────────
function atualizarEmailsModeradores(emails, solicitante) {
  // Apenas admin pode gerenciar moderadores, não moderadores
  if (!verificarSeAdmin(solicitante)) {
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode gerenciar moderadores.' });
  }
  try {
    var planilha = obterPlanilhaChat();
    var aba = planilha.getSheetByName(ABA_CONFIG);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba Config não encontrada.' });
    
    var dados = aba.getDataRange().getValues();
    var agora = new Date().toLocaleString();
    var encontrado = false;
    
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).trim() === 'EmailsModeradores') {
        aba.getRange(i+1, 2).setValue(emails);
        aba.getRange(i+1, 3).setValue(agora);
        encontrado = true;
        break;
      }
    }
    
    if (!encontrado) {
      aba.appendRow(['EmailsModeradores', emails, agora]);
    }
    
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(ckConfig());
    registrarLogSistema('ADMIN', solicitante, 'Moderadores atualizados', emails);
    return JSON.stringify({ ok:true, emails:emails });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function listarUsuariosParaModeracao() {
  try {
    // Tentar obter do cache primeiro (TTL de 30 segundos)
    var cache = CacheService.getScriptCache();
    var cacheKey = 'usuarios_moderacao';
    var cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
    
    var planilha = obterPlanilhaChat();
    var abaUsuarios = planilha.getSheetByName(ABA_USUARIOS);
    if (!abaUsuarios) return JSON.stringify({ ok:false, erro:'Aba Usuarios não encontrada.' });
    
    var dados = abaUsuarios.getDataRange().getValues();
    var usuarios = [];
    
    // Pular cabeçalho
    for (var i = 1; i < dados.length; i++) {
      var email = normalizarEmail(dados[i][0]);
      var nome = String(dados[i][1] || '');
      var status = String(dados[i][4] || '').toUpperCase();
      
      if (email && status !== 'BLOQUEADO') {
        var ehModerador = verificarSeModerador(email);
        usuarios.push({
          email: email,
          nome: nome,
          ehModerador: ehModerador
        });
      }
    }
    
    // Ordenar por nome
    usuarios.sort(function(a, b) {
      return a.nome.localeCompare(b.nome);
    });
    
    var result = JSON.stringify({ ok:true, usuarios:usuarios });
    
    // Cache por 30 segundos
    cache.put(cacheKey, result, 30);
    
    return result;
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function atribuirModerador(email, solicitante, senha) {
  // Apenas admin pode atribuir moderadores (por email na lista OU por senha)
  var isAdminPorEmail = verificarSeAdmin(solicitante);
  var isAdminPorSenha = senha && verificarSenhaAdmin(senha);
  
  if (!isAdminPorEmail && !isAdminPorSenha) {
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode atribuir moderadores.' });
  }
  try {
    var planilha = obterPlanilhaChat();
    var abaModeracao = planilha.getSheetByName(ABA_MODERACAO);
    if (!abaModeracao) {
      // Criar aba Moderacao se não existir
      abaModeracao = planilha.insertSheet(ABA_MODERACAO);
      var est = obterEstruturaAbas().Moderacao;
      aplicarCabecalhoEAjustes(abaModeracao, est.headers, null);
      formatarLinhaCabecalho(abaModeracao, est.headers.length);
    }
    
    // Verificar se usuário já é moderador
    var dados = abaModeracao.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (normalizarEmail(dados[i][0]) === normalizarEmail(email)) {
        return JSON.stringify({ ok:false, erro:'Este usuário já é moderador.' });
      }
    }
    
    // Obter nome do usuário
    var abaUsuarios = planilha.getSheetByName(ABA_USUARIOS);
    var dadosUsuarios = abaUsuarios.getDataRange().getValues();
    var nome = '';
    for (var i = 1; i < dadosUsuarios.length; i++) {
      if (normalizarEmail(dadosUsuarios[i][0]) === normalizarEmail(email)) {
        nome = String(dadosUsuarios[i][1] || '');
        break;
      }
    }
    
    var agora = new Date().toLocaleString();
    abaModeracao.appendRow([email, nome, 'ATIVO', agora, solicitante]);
    SpreadsheetApp.flush();
    
    // Atualizar configuração EmailsModeradores
    atualizarListaModeradoresNaConfig();
    
    // Limpar cache de usuários para moderação
    CacheService.getScriptCache().remove('usuarios_moderacao');
    
    registrarLogSistema('ADMIN', solicitante, 'Moderador atribuído', email + ' - ' + nome);
    return JSON.stringify({ ok:true });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function revogarModerador(email, solicitante, senha) {
  // Apenas admin pode revogar moderadores (por email na lista OU por senha)
  var isAdminPorEmail = verificarSeAdmin(solicitante);
  var isAdminPorSenha = senha && verificarSenhaAdmin(senha);
  
  if (!isAdminPorEmail && !isAdminPorSenha) {
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode revogar moderadores.' });
  }
  try {
    var planilha = obterPlanilhaChat();
    var abaModeracao = planilha.getSheetByName(ABA_MODERACAO);
    if (!abaModeracao) return JSON.stringify({ ok:false, erro:'Aba Moderacao não encontrada.' });
    
    var dados = abaModeracao.getDataRange().getValues();
    var encontrado = false;
    
    for (var i = 1; i < dados.length; i++) {
      if (normalizarEmail(dados[i][0]) === normalizarEmail(email)) {
        abaModeracao.deleteRow(i+1);
        encontrado = true;
        break;
      }
    }
    
    if (!encontrado) {
      return JSON.stringify({ ok:false, erro:'Moderador não encontrado.' });
    }
    
    SpreadsheetApp.flush();
    
    // Atualizar configuração EmailsModeradores
    atualizarListaModeradoresNaConfig();
    
    // Limpar cache de usuários para moderação
    CacheService.getScriptCache().remove('usuarios_moderacao');
    
    registrarLogSistema('ADMIN', solicitante, 'Moderador revogado', email);
    return JSON.stringify({ ok:true });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function atualizarListaModeradoresNaConfig() {
  try {
    var planilha = obterPlanilhaChat();
    var abaModeracao = planilha.getSheetByName(ABA_MODERACAO);
    if (!abaModeracao) return;
    
    var dados = abaModeracao.getDataRange().getValues();
    var emails = [];
    
    for (var i = 1; i < dados.length; i++) {
      var status = String(dados[i][2] || '').toUpperCase();
      if (status === 'ATIVO') {
        emails.push(normalizarEmail(dados[i][0]));
      }
    }
    
    var abaConfig = planilha.getSheetByName(ABA_CONFIG);
    if (!abaConfig) return;
    
    var dadosConfig = abaConfig.getDataRange().getValues();
    var agora = new Date().toLocaleString();
    var encontrado = false;
    
    for (var i = 1; i < dadosConfig.length; i++) {
      if (String(dadosConfig[i][0]).trim() === 'EmailsModeradores') {
        abaConfig.getRange(i+1, 2).setValue(emails.join(','));
        abaConfig.getRange(i+1, 3).setValue(agora);
        encontrado = true;
        break;
      }
    }
    
    if (!encontrado) {
      abaConfig.appendRow(['EmailsModeradores', emails.join(','), agora]);
    }
    
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(ckConfig());
  } catch(e) {
    Logger.log('Erro ao atualizar lista de moderadores na config: ' + e.message);
  }
}

function adicionarAdminPorSenha(email) {
  try {
    Logger.log('adicionarAdminPorSenha chamado para email: ' + email);
    var planilha = obterPlanilhaChat();
    var abaConfig = planilha.getSheetByName(ABA_CONFIG);
    if (!abaConfig) {
      Logger.log('Erro: Aba Config não encontrada');
      return JSON.stringify({ ok:false, erro:'Aba Config não encontrada.' });
    }
    
    var dados = abaConfig.getDataRange().getValues();
    var listaAtual = '';
    var encontrado = false;
    
    Logger.log('Procurando linha EmailsAdmins na aba Config');
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).trim() === 'EmailsAdmins') {
        listaAtual = String(dados[i][1] || '');
        var emails = listaAtual ? listaAtual.split(',').map(function(x){ return x.trim(); }).filter(Boolean) : [];
        var emailNorm = normalizarEmail(email);
        
        Logger.log('Lista atual de admins: ' + listaAtual);
        Logger.log('Email normalizado: ' + emailNorm);
        Logger.log('Emails na lista: ' + emails.join(','));
        
        // Verificar se email já está na lista
        if (emails.indexOf(emailNorm) === -1) {
          Logger.log('Email não está na lista, adicionando...');
          emails.push(emailNorm);
          abaConfig.getRange(i+1, 2).setValue(emails.join(','));
          abaConfig.getRange(i+1, 3).setValue(new Date().toLocaleString());
          SpreadsheetApp.flush();
          CacheService.getScriptCache().remove(ckConfig());
          registrarLogSistema('ADMIN', email, 'Email adicionado à lista de admins por senha', email);
          Logger.log('Email adicionado com sucesso');
        } else {
          Logger.log('Email já está na lista');
        }
        encontrado = true;
        break;
      }
    }
    
    if (!encontrado) {
      Logger.log('Linha EmailsAdmins não encontrada, criando nova linha');
      abaConfig.appendRow(['EmailsAdmins', email, new Date().toLocaleString()]);
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckConfig());
      registrarLogSistema('ADMIN', email, 'Email adicionado à lista de admins por senha', email);
    }
    
    Logger.log('Retornando ok:true');
    return JSON.stringify({ ok:true });
  } catch(e) {
    Logger.log('Erro em adicionarAdminPorSenha: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Usuários ──────────────────────────────────────────────

function bloquearUsuario(email, motivo, solicitante) {
  // Apenas admin pode bloquear usuários, não moderadores
  if (!verificarSeAdmin(solicitante)) {
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode bloquear usuários.' });
  }
  return _setStatusUsuario(normalizarEmail(email), 'BLOQUEADO', motivo, solicitante);
}

function desbloquearUsuario(email, solicitante) {
  // Apenas admin pode desbloquear usuários, não moderadores
  if (!verificarSeAdmin(solicitante)) {
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode desbloquear usuários.' });
  }
  return _setStatusUsuario(normalizarEmail(email), 'Ativo', 'Desbloqueado', solicitante);
}

function verificarUsuarioBloqueado(email) {
  var em = normalizarEmail(email);
  if (!em) return JSON.stringify({ bloqueado:false });
  try {
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return JSON.stringify({ bloqueado:false });
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).toLowerCase().trim() === em) {
        var s = String(dados[i][4]||'').trim().toUpperCase();
        return JSON.stringify({ bloqueado: s === 'BLOQUEADO', status:s });
      }
    }
    return JSON.stringify({ bloqueado:false });
  } catch(e) { return JSON.stringify({ bloqueado:false }); }
}

function _setStatusUsuario(em, status, motivo, solicitante) {
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(4000);
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada.' });
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).toLowerCase().trim() === em) {
        aba.getRange(i+1,5).setValue(status);
        SpreadsheetApp.flush();
        CacheService.getScriptCache().remove(ckUsuarios());
        registrarLogSistema('ADMIN', solicitante || 'Sistema', status==='BLOQUEADO'?'Bloqueado':'Desbloqueado', em+' - '+(motivo||''));
        return JSON.stringify({ ok:true });
      }
    }
    return JSON.stringify({ ok:false, erro:'Usuário não encontrado.' });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
  finally   { if (trava.hasLock()) trava.releaseLock(); }
}

// ── Pedidos de nome ───────────────────────────────────────

function listarPedidosPendentes() {
  try {
    var aba = obterAbaPorNome(ABA_PEDIDOS);
    if (!aba || aba.getLastRow() < 2) return [];
    var dados = aba.getDataRange().getValues();
    return dados.slice(1).reduce(function(acc, r, i) {
      if (String(r[2]||'').trim() === 'Pendente')
        acc.push({ linha:i+2, nomeAtual:String(r[0]), nomeNovo:String(r[1]),
                   status:'Pendente', dataHora:String(r[3]), email:String(r[4]||'') });
      return acc;
    }, []);
  } catch(e) { return []; }
}

function responderPedidoNome(linha, decisao, solicitante) {
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(5000);
    var planilha   = obterPlanilhaChat();
    var abaPedidos = planilha.getSheetByName(ABA_PEDIDOS);
    var nomeAntigo = String(abaPedidos.getRange(linha,1).getValue()).trim();
    var nomeNovo   = String(abaPedidos.getRange(linha,2).getValue()).trim();
    var emailPedido= normalizarEmail(abaPedidos.getRange(linha,5).getValue());
    abaPedidos.getRange(linha,3).setValue(decisao);
    var linhasAtualizadas = 0;
    if (decisao === 'Aprovado') {
      linhasAtualizadas = _atualizarNomeRetroativo(planilha, nomeAntigo, nomeNovo);
      if (emailPedido) vincularUsuarioNome(emailPedido, nomeNovo, true);
      registrarLogSistema('ADMIN', solicitante || 'Sistema', 'Nome alterado', nomeAntigo+'→'+nomeNovo);
      // Enviar notificação pessoal ao usuário
      if (emailPedido) {
        _enviarNotifPessoal(emailPedido,
          '✅ Troca de nome aprovada! Seu nome agora é "' + nomeNovo + '".',
          'aprovacao', 20);
      }
    } else {
      registrarLogSistema('ADMIN', solicitante || 'Sistema', 'Troca recusada', nomeAntigo+' tentou '+nomeNovo);
      // Enviar notificação pessoal ao usuário
      if (emailPedido) {
        _enviarNotifPessoal(emailPedido,
          '❌ Seu pedido de troca de nome para "' + nomeNovo + '" foi recusado.',
          'recusa', 20);
      }
    }
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(ckUsuarios());
    return JSON.stringify({ ok:true, decisao:decisao, nomeAntigo:nomeAntigo, nomeNovo:nomeNovo, linhasAtualizadas:linhasAtualizadas });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
  finally   { if (trava.hasLock()) trava.releaseLock(); }
}

// ── Notificação pessoal via cache (leve, não polui tabela global) ──
function _enviarNotifPessoal(email, mensagem, tipo, duracaoSeg) {
  try {
    var em = normalizarEmail(email);
    if (!em) return;
    var ck = 'notif_pessoal_' + em.replace(/[^a-z0-9]/g,'_');
    var notif = {
      id:       'np_' + Date.now(),
      mensagem: String(mensagem||''),
      tipo:     String(tipo||'info'),
      duracao:  parseInt(duracaoSeg)||15,
      ts:       Date.now(),
      origem:   'sistema'
    };
    CacheService.getScriptCache().put(ck, JSON.stringify(notif), duracaoSeg + 5);
  } catch(e) {}
}

// ── Obter notificação pessoal pendente ──────────────────────
function obterNotifPessoal(emailUsuario) {
  try {
    var em = normalizarEmail(emailUsuario);
    if (!em) return JSON.stringify({ ok:true, notificacao:null });
    var ck = 'notif_pessoal_' + em.replace(/[^a-z0-9]/g,'_');
    var raw = CacheService.getScriptCache().get(ck);
    if (!raw) return JSON.stringify({ ok:true, notificacao:null });
    var notif = JSON.parse(raw);
    // Consumir a notificação — remover do cache após leitura
    CacheService.getScriptCache().remove(ck);
    return JSON.stringify({ ok:true, notificacao:notif });
  } catch(e) {
    return JSON.stringify({ ok:true, notificacao:null });
  }
}

function processarTodosPedidos(decisao) {
  var pendentes = listarPedidosPendentes();
  var processados = 0;
  pendentes.forEach(function(p) {
    try {
      var r = JSON.parse(responderPedidoNome(p.linha, decisao));
      if (r.ok) processados++;
    } catch(x){}
  });
  return JSON.stringify({ ok:true, processados:processados });
}

function _atualizarNomeRetroativo(planilha, antigo, novo) {
  var al = String(antigo).toLowerCase();
  var novoLimpo = String(novo).trim();
  var cnt = 0;

  // ── 1. Mensagens de grupo (coluna Remetente = col 3, índice 2) ──
  var abaMsgs = planilha.getSheetByName(ABA_MENSAGENS);
  if (abaMsgs) {
    var dados = abaMsgs.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][2]||'').trim().toLowerCase() === al) {
        abaMsgs.getRange(i+1,3).setValue(novoLimpo);
        cnt++;
      }
    }
    if (cnt > 0) SpreadsheetApp.flush();
  }

  // ── 2. Conversas privadas — Nome1 (col 3, índice 2) e Nome2 (col 5, índice 4) ──
  var abaConv = planilha.getSheetByName(ABA_CONVERSAS_PRIVADAS);
  if (abaConv) {
    var dadosConv = abaConv.getDataRange().getValues();
    var cntConv = 0;
    for (var j = 1; j < dadosConv.length; j++) {
      if (String(dadosConv[j][2]||'').trim().toLowerCase() === al) {
        abaConv.getRange(j+1,3).setValue(novoLimpo); cntConv++;
      }
      if (String(dadosConv[j][4]||'').trim().toLowerCase() === al) {
        abaConv.getRange(j+1,5).setValue(novoLimpo); cntConv++;
      }
    }
    if (cntConv > 0) SpreadsheetApp.flush();
    cnt += cntConv;
  }

  // ── 3. Mensagens privadas — NomeRemetente (col 3, índice 2) ──
  var abaMsgPriv = planilha.getSheetByName(ABA_MENSAGENS_PRIVADAS);
  if (abaMsgPriv) {
    var dadosMp = abaMsgPriv.getDataRange().getValues();
    var cntMp = 0;
    for (var k = 1; k < dadosMp.length; k++) {
      if (String(dadosMp[k][2]||'').trim().toLowerCase() === al) {
        abaMsgPriv.getRange(k+1,3).setValue(novoLimpo); cntMp++;
      }
    }
    if (cntMp > 0) SpreadsheetApp.flush();
    cnt += cntMp;
  }

  // ── 4. Invalidar caches ──
  CacheService.getScriptCache().remove(ckConversasPrivadas());
  CacheService.getScriptCache().remove(ckUsuarios());

  return cnt;
}

// ── Notificações globais ──────────────────────────────────

function salvarNotificacao(mensagem, duracao, tipo) {
  try {
    var aba = _garantirAbaNotificacoes();
    var dados = aba.getDataRange().getValues();
    // Desativar anteriores
    for (var i = 1; i < dados.length; i++) {
      var at = dados[i][1];
      if (at === true || at === 'true' || at === 'TRUE')
        aba.getRange(i+1,2).setValue(false);
    }
    var ts = Date.now(), id = 'notif_' + ts;
    aba.appendRow([id, true, String(mensagem||''), parseInt(duracao)||0, String(tipo||'info'), ts, new Date().toLocaleString(), '']);
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(ckNotif());
    registrarLogSistema('NOTIFICACAO','Sistema','Notificação enviada', mensagem);
    return JSON.stringify({ ok:true, id:id });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function obterNotificacaoAtiva(emailUsuario) {
  try {
    var cache = CacheService.getScriptCache();
    var ck    = ckNotif();
    var raw   = cache.get(ck);
    var lista;
    if (raw) {
      lista = JSON.parse(raw);
    } else {
      var aba = _garantirAbaNotificacoes();
      var dados = aba.getDataRange().getValues();
      lista = []; // id, ativa, msg, dur, tipo, ts, dataCriacao, usuariosFecharam
      for (var i = 1; i < dados.length; i++) {
        lista.push({ id:dados[i][0], ativa:dados[i][1], mensagem:dados[i][2],
                     duracao:parseInt(dados[i][3])||0, tipo:dados[i][4],
                     ts:parseInt(dados[i][5])||0, fecharam:String(dados[i][7]||'') });
      }
      _cachePutSafe(CacheService.getScriptCache(), ck, JSON.stringify(lista), 15);
    }
    var agora = Date.now();
    for (var j = lista.length-1; j >= 0; j--) {
      var n = lista[j];
      var at = n.ativa === true || n.ativa === 'true' || n.ativa === 'TRUE';
      if (!at) continue;
      if (n.duracao > 0 && n.ts > 0 && (agora - n.ts)/1000 > n.duracao) {
        _desativarNotif(n.id);
        CacheService.getScriptCache().remove(ck);
        continue;
      }
      if (emailUsuario && n.fecharam) {
        var em = normalizarEmail(emailUsuario);
        var fecharam = n.fecharam.split(',').map(function(x){return x.trim().toLowerCase();});
        if (fecharam.indexOf(em) !== -1) continue;
      }
      return JSON.stringify({ ok:true, notificacao:{ ativa:true, id:n.id, mensagem:n.mensagem, duracao:n.duracao, tipo:n.tipo, ts:n.ts } });
    }
    return JSON.stringify({ ok:true, notificacao:{ ativa:false } });
  } catch(e) { return JSON.stringify({ ok:true, notificacao:{ ativa:false } }); }
}

function registrarUsuarioFechouNotificacao(idNotificacao, emailUsuario) {
  try {
    var aba  = _garantirAbaNotificacoes();
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) === idNotificacao) {
        var lista = String(dados[i][7]||'').split(',').filter(Boolean);
        var em = normalizarEmail(emailUsuario);
        if (lista.map(function(x){return x.trim().toLowerCase();}).indexOf(em) === -1) {
          lista.push(emailUsuario);
          aba.getRange(i+1,8).setValue(lista.join(','));
          SpreadsheetApp.flush();
          CacheService.getScriptCache().remove(ckNotif());
        }
        return JSON.stringify({ ok:true });
      }
    }
    return JSON.stringify({ ok:false });
  } catch(e) { return JSON.stringify({ ok:false }); }
}

function _desativarNotif(id) {
  try {
    var aba = _garantirAbaNotificacoes();
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) === id) { aba.getRange(i+1,2).setValue(false); SpreadsheetApp.flush(); break; }
    }
  } catch(e){}
}

// ── Bloqueio do sistema ───────────────────────────────────

function ativarBloqueioSistema(mensagem, previsao, tipo) {
  try {
    definirConfiguracao('SistemaBloqueado','true');
    definirConfiguracao('MensagemBloqueio', String(mensagem||''));
    definirConfiguracao('PrevisaoBloqueio', String(previsao||''));
    definirConfiguracao('TipoBloqueio', String(tipo||'TUDO'));
    registrarLogSistema('BLOQUEIO','Sistema','Bloqueio ativado', mensagem);
    return JSON.stringify({ ok:true });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function desativarBloqueioSistema() {
  try {
    definirConfiguracao('SistemaBloqueado','false');
    registrarLogSistema('BLOQUEIO','Sistema','Sistema desbloqueado','');
    return JSON.stringify({ ok:true });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function obterStatusBloqueio() {
  try {
    return JSON.stringify({
      ok:         true,
      bloqueado:  obterConfiguracao('SistemaBloqueado') === 'true',
      mensagem:   obterConfiguracao('MensagemBloqueio') || '',
      previsao:   obterConfiguracao('PrevisaoBloqueio') || '',
      tipoBloqueio: obterConfiguracao('TipoBloqueio')  || 'TUDO'
    });
  } catch(e) { return JSON.stringify({ ok:true, bloqueado:false }); }
}

// ── Fixar mensagem ────────────────────────────────────────

function fixarMensagem(idMensagem, emailAdmin, idGrupo) {
  try {
    var isAdminSist = verificarSeAdmin(emailAdmin) || _isAdminSistema(emailAdmin);
    var ehGrupoGeral = String(idGrupo||'').toLowerCase() === 'grupo_geral';

    if (ehGrupoGeral) {
      // Grupo Geral: só admin do sistema
      if (!isAdminSist)
        return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode fixar mensagens no Grupo Geral.' });
    } else {
      // Grupos privados: admin do grupo ou admin do sistema
      if (!isAdminSist) {
        var isAdminGrupo = _verificarAdminGrupoParaFixar(idGrupo, emailAdmin);
        if (!isAdminGrupo)
          return JSON.stringify({ ok:false, erro:'Apenas admins do grupo ou do sistema podem fixar mensagens.' });
      }
    }

    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada.' });
    var dados = aba.getDataRange().getValues();
    var cols  = aba.getLastColumn();
    if (cols < 13) aba.getRange(1,13).setValue('Fixada');
    // Desafixar anterior do grupo
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][3]||'') === idGrupo && String(dados[i][12]||'') === 'FIXADA')
        aba.getRange(i+1, 13).setValue('');
    }
    // Fixar nova
    for (var j = 1; j < dados.length; j++) {
      if (String(dados[j][6]||'') === idMensagem) { aba.getRange(j+1, 13).setValue('FIXADA'); break; }
    }
    SpreadsheetApp.flush();
    _invalidarCacheMsgs(idGrupo);
    registrarLogSistema('ADMIN', emailAdmin, 'Mensagem fixada', 'ID:'+idMensagem+' Grupo:'+idGrupo);
    return JSON.stringify({ ok:true });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function _verificarAdminGrupoParaFixar(idGrupo, emailAdmin) {
  try {
    var aba   = obterAbaPorNome(ABA_GRUPOS);
    if (!aba) return false;
    var dados = aba.getDataRange().getValues();
    var em    = String(emailAdmin||'').toLowerCase().trim();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) !== idGrupo) continue;
      var admins = String(dados[i][7]||dados[i][3]||'').split(',').map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
      return admins.indexOf(em) !== -1;
    }
    return false;
  } catch(e) { return false; }
}

function desfixarMensagem(idMensagem, emailAdmin) {
  if (!verificarSeAdmin(emailAdmin)) return JSON.stringify({ ok:false, erro:'Apenas admins.' });
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ ok:false, erro:'Aba não encontrada.' });
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][6]||'') === idMensagem) { aba.getRange(i+1,13).setValue(''); break; }
    }
    SpreadsheetApp.flush();
    registrarLogSistema('ADMIN',emailAdmin,'Mensagem desfixada','ID:'+idMensagem);
    return JSON.stringify({ ok:true });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function obterMensagemFixada(idGrupo, emailUsuario) {
  // Verificar acesso ao grupo antes de retornar mensagem fixada
  if (!_verificarAcessoGrupo(idGrupo, normalizarEmail(emailUsuario), '')) {
    return JSON.stringify({ ok:true, fixada:null });
  }
  try {
    var aba = obterAbaPorNome(ABA_MENSAGENS);
    if (!aba) return JSON.stringify({ ok:true, fixada:null });
    var dados = aba.getDataRange().getValues();
    for (var i = dados.length-1; i >= 1; i--) {
      if (String(dados[i][3]||'') === idGrupo && String(dados[i][12]||'') === 'FIXADA') {
        return JSON.stringify({ ok:true, fixada:{
          id:dados[i][6], data:dados[i][0], hora:dados[i][1],
          autor:dados[i][2], mensagem:dados[i][11]||dados[i][4]
        }});
      }
    }
    return JSON.stringify({ ok:true, fixada:null });
  } catch(e) { return JSON.stringify({ ok:true, fixada:null }); }
}

// ── Painel Admin ──────────────────────────────────────────

function obterPainelAdminCompleto() {
  try {
    var stats      = obterEstatisticasSistema();
    var pendentes  = listarPedidosPendentes();
    var logs       = obterLogsSistema(LOGS_RECENTES_LIMITE);
    var gruposRaw  = JSON.parse(listarTodosGrupos());

    var historico = [];
    var abaPedidos = obterAbaPorNome(ABA_PEDIDOS);
    if (abaPedidos && abaPedidos.getLastRow() > 1) {
      var dp = abaPedidos.getDataRange().getValues();
      for (var i = 1; i < dp.length; i++) {
        if (String(dp[i][2]||'').trim() !== 'Pendente') {
          historico.push({ atual:dp[i][0], novo:dp[i][1], status:dp[i][2], data:dp[i][3] });
        }
      }
    }
    return JSON.stringify({
      estatisticas: stats, pendentes: pendentes,
      historico: historico, logsRecentes: logs,
      grupos: gruposRaw.grupos||[], versao: SISTEMA_VERSAO
    });
  } catch(e) { return JSON.stringify({ erro:e.message }); }
}

function obterEstatisticasSistema() {
  try {
    var cache = CacheService.getScriptCache();
    var hoje  = Utilities.formatDate(new Date(),'GMT-3','dd/MM/yyyy');
    var stats = { totalUsuarios:0, online:0, bloqueados:0, totalMensagens:0, mensagensHoje:0, pedidosPendentes:0, versao:SISTEMA_VERSAO };
    var abaU  = obterAbaPorNome(ABA_USUARIOS);
    if (abaU && abaU.getLastRow() > 1) {
      var du = abaU.getDataRange().getValues();
      var emails = {};
      for (var i = 1; i < du.length; i++) {
        var em = String(du[i][0]||'').toLowerCase().trim();
        var nm = String(du[i][1]||'').trim();
        var st = String(du[i][4]||'').toLowerCase();
        if (!nm || (em && emails[em])) continue;
        if (em) emails[em]=true;
        stats.totalUsuarios++;
        if (cache.get(ckOnline(nm)) === 'sim') stats.online++;
        if (st === 'bloqueado') stats.bloqueados++;
      }
    }
    var abaM = obterAbaPorNome(ABA_MENSAGENS);
    if (abaM && abaM.getLastRow() > 1) {
      var dm = abaM.getDataRange().getValues();
      for (var j = 1; j < dm.length; j++) {
        if (String(dm[j][4]||'').indexOf('[APAGADA]') === 0) continue;
        stats.totalMensagens++;
        if (String(dm[j][0]) === hoje) stats.mensagensHoje++;
      }
    }
    var abaP = obterAbaPorNome(ABA_PEDIDOS);
    if (abaP && abaP.getLastRow() > 1) {
      var dp2 = abaP.getDataRange().getValues();
      for (var k = 1; k < dp2.length; k++) {
        if (String(dp2[k][2]||'').trim() === 'Pendente') stats.pedidosPendentes++;
      }
    }
    return stats;
  } catch(e) { return { erro:e.message }; }
}

function exportarDadosAdmin() {
  try {
    var planilha = obterPlanilhaChat();
    var dados = { sistema:obterInfoSistema(), exportadoEm:new Date().toISOString(), usuarios:[], mensagens:[], logs:[] };
    var abaU = planilha.getSheetByName(ABA_USUARIOS);
    if (abaU) {
      var du = abaU.getDataRange().getValues();
      for (var i = 1; i < du.length; i++)
        dados.usuarios.push({ email:du[i][0], nome:du[i][1], status:du[i][4] });
    }
    var abaM = planilha.getSheetByName(ABA_MENSAGENS);
    if (abaM) {
      var dm = abaM.getDataRange().getValues();
      for (var j = 1; j < Math.min(dm.length, MAX_MENSAGENS_EXPORTAR+1); j++)
        dados.mensagens.push({ data:dm[j][0], hora:dm[j][1], remetente:dm[j][2], destino:dm[j][3], mensagem:dm[j][4] });
    }
    dados.logs = obterLogsSistema(100);
    return JSON.stringify(dados, null, 2);
  } catch(e) { return JSON.stringify({ erro:e.message }); }
}

// ── Grupos admin ──────────────────────────────────────────

function adminCriarGrupo(nome, desc, icone, senha, emailAdmin) {
  if (!verificarSenhaAdmin(senha)) return JSON.stringify({ ok:false, erro:'Senha incorreta.' });
  // Apenas admin pode criar grupos, não moderadores
  if (!verificarSeAdmin(emailAdmin)) {
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode criar grupos.' });
  }
  // Usar email real do admin como criador; 'todos' como membros (grupo público — admin pode restringir depois)
  var criador = (emailAdmin && emailAdmin.indexOf('@') > 0) ? emailAdmin.toLowerCase().trim() : 'sistema@sonne.admin';
  return criarGrupo(nome, desc, criador, icone);
}

function adminDeletarGrupo(id, senha, emailAdmin) {
  if (!verificarSenhaAdmin(senha)) return JSON.stringify({ ok:false, erro:'Senha incorreta.' });
  // Apenas admin pode deletar grupos, não moderadores
  if (!verificarSeAdmin(emailAdmin)) {
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode deletar grupos.' });
  }
  return deletarGrupo(id, emailAdmin);
}

function adminAdicionarMembroGrupo(id, email, senha) {
  if (!verificarSenhaAdmin(senha)) return JSON.stringify({ ok:false, erro:'Senha incorreta.' });
  return adicionarMembroGrupo(id, email, _getAdminToken());
}

function adminRemoverMembroGrupo(id, email, senha) {
  if (!verificarSenhaAdmin(senha)) return JSON.stringify({ ok:false, erro:'Senha incorreta.' });
  return removerMembroGrupo(id, email, _getAdminToken());
}

// ── Helper aba notificações ───────────────────────────────

function _garantirAbaNotificacoes() {
  var aba = obterAbaPorNome(ABA_NOTIF);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_NOTIF);
    var est = obterEstruturaAbas().Notificacoes;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
  }
  return aba;
}

// ── RATE LIMITING (RateLimiting.gs) ─────────────────────────

// ── Configurações de Rate Limiting ─────────────────────────
const MAX_MENSAGENS_MINUTO = 30; // Máximo de mensagens por minuto
const MAX_MENSAGENS_HORA = 200; // Máximo de mensagens por hora
const MAX_UPLOADS_DIA = 50; // Máximo de uploads por dia
const MAX_GRUPOS_DIA = 10; // Máximo de criação de grupos por dia

// ── Verificar rate limit de mensagens ───────────────────────
function verificarRateLimitMensagem(emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return { permitido:true, restante:MAX_MENSAGENS_MINUTO };
  
  try {
    var cache = CacheService.getScriptCache();
    var agora = Date.now();
    
    // Chave para contador de mensagens por minuto
    var chaveMinuto = 'ratelimit_msg_min_' + em + '_' + Math.floor(agora / 60000);
    var contagemMinuto = parseInt(cache.get(chaveMinuto) || '0');
    
    // Chave para contador de mensagens por hora
    var chaveHora = 'ratelimit_msg_hr_' + em + '_' + Math.floor(agora / 3600000);
    var contagemHora = parseInt(cache.get(chaveHora) || '0');
    
    // Verificar limites
    if (contagemMinuto >= MAX_MENSAGENS_MINUTO) {
      return { permitido:false, motivo:'Limite de ' + MAX_MENSAGENS_MINUTO + ' mensagens/minuto excedido', restante:0, resetEm:60 };
    }
    
    if (contagemHora >= MAX_MENSAGENS_HORA) {
      return { permitido:false, motivo:'Limite de ' + MAX_MENSAGENS_HORA + ' mensagens/hora excedido', restante:0, resetEm:3600 };
    }
    
    // Incrementar contadores
    cache.put(chaveMinuto, String(contagemMinuto + 1), 61);
    cache.put(chaveHora, String(contagemHora + 1), 3601);
    
    return { 
      permitido:true, 
      restante:MAX_MENSAGENS_MINUTO - (contagemMinuto + 1),
      restanteHora:MAX_MENSAGENS_HORA - (contagemHora + 1)
    };
  } catch(e) {
    // Em caso de erro, permitir para não bloquear o sistema
    return { permitido:true, restante:MAX_MENSAGENS_MINUTO };
  }
}

// ── Verificar rate limit de uploads ─────────────────────────
function verificarRateLimitUpload(emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return { permitido:true, restante:MAX_UPLOADS_DIA };
  
  try {
    var cache = CacheService.getScriptCache();
    var agora = Date.now();
    var dia = Math.floor(agora / 86400000);
    
    var chave = 'ratelimit_upload_' + em + '_' + dia;
    var contagem = parseInt(cache.get(chave) || '0');
    
    if (contagem >= MAX_UPLOADS_DIA) {
      return { permitido:false, motivo:'Limite de ' + MAX_UPLOADS_DIA + ' uploads/dia excedido', restante:0 };
    }
    
    cache.put(chave, String(contagem + 1), 86401);
    
    return { permitido:true, restante:MAX_UPLOADS_DIA - (contagem + 1) };
  } catch(e) {
    return { permitido:true, restante:MAX_UPLOADS_DIA };
  }
}

// ── Verificar rate limit de criação de grupos ───────────────
function verificarRateLimitGrupo(emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return { permitido:true, restante:MAX_GRUPOS_DIA };
  
  try {
    var cache = CacheService.getScriptCache();
    var agora = Date.now();
    var dia = Math.floor(agora / 86400000);
    
    var chave = 'ratelimit_grupo_' + em + '_' + dia;
    var contagem = parseInt(cache.get(chave) || '0');
    
    if (contagem >= MAX_GRUPOS_DIA) {
      return { permitido:false, motivo:'Limite de ' + MAX_GRUPOS_DIA + ' grupos/dia excedido', restante:0 };
    }
    
    cache.put(chave, String(contagem + 1), 86401);
    
    return { permitido:true, restante:MAX_GRUPOS_DIA - (contagem + 1) };
  } catch(e) {
    return { permitido:true, restante:MAX_GRUPOS_DIA };
  }
}

// ── Obter estatísticas de rate limit ─────────────────────────
function obterEstatisticasRateLimit(emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  
  try {
    var cache = CacheService.getScriptCache();
    var agora = Date.now();
    
    var chaveMinuto = 'ratelimit_msg_min_' + em + '_' + Math.floor(agora / 60000);
    var chaveHora = 'ratelimit_msg_hr_' + em + '_' + Math.floor(agora / 3600000);
    var dia = Math.floor(agora / 86400000);
    var chaveUpload = 'ratelimit_upload_' + em + '_' + dia;
    var chaveGrupo = 'ratelimit_grupo_' + em + '_' + dia;
    
    return JSON.stringify({
      ok:true,
      mensagens: {
        minuto: parseInt(cache.get(chaveMinuto) || '0'),
        hora: parseInt(cache.get(chaveHora) || '0'),
        limiteMinuto: MAX_MENSAGENS_MINUTO,
        limiteHora: MAX_MENSAGENS_HORA
      },
      uploads: {
        dia: parseInt(cache.get(chaveUpload) || '0'),
        limite: MAX_UPLOADS_DIA
      },
      grupos: {
        dia: parseInt(cache.get(chaveGrupo) || '0'),
        limite: MAX_GRUPOS_DIA
      }
    });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Resetar rate limit (admin only) ─────────────────────────
function resetarRateLimit(emailUsuario, senhaAdmin) {
  if (!getSenhaAdmin || String(senhaAdmin) !== getSenhaAdmin()) {
    return JSON.stringify({ ok:false, erro:'Senha admin incorreta.' });
  }
  
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  
  try {
    var cache = CacheService.getScriptCache();
    var agora = Date.now();
    
    // Remover todas as chaves do usuário
    var chaveMinuto = 'ratelimit_msg_min_' + em + '_' + Math.floor(agora / 60000);
    var chaveHora = 'ratelimit_msg_hr_' + em + '_' + Math.floor(agora / 3600000);
    var dia = Math.floor(agora / 86400000);
    var chaveUpload = 'ratelimit_upload_' + em + '_' + dia;
    var chaveGrupo = 'ratelimit_grupo_' + em + '_' + dia;
    
    cache.remove(chaveMinuto);
    cache.remove(chaveHora);
    cache.remove(chaveUpload);
    cache.remove(chaveGrupo);
    
    registrarLogSistema('ADMIN', 'Sistema', 'Rate limit resetado', 'Usuario:' + em);
    
    return JSON.stringify({ ok:true });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Detectar comportamento suspeito (spam) ───────────────────
function detectarComportamentoSuspeito(emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return { suspeito:false, motivo:'' };
  
  try {
    var cache = CacheService.getScriptCache();
    var agora = Date.now();
    
    // Verificar se enviou muitas mensagens em pouco tempo
    var chaveMinuto = 'ratelimit_msg_min_' + em + '_' + Math.floor(agora / 60000);
    var contagemMinuto = parseInt(cache.get(chaveMinuto) || '0');
    
    if (contagemMinuto >= MAX_MENSAGENS_MINUTO * 0.8) {
      return { suspeito:true, motivo:'Alta frequência de mensagens detectada' };
    }
    
    return { suspeito:false, motivo:'' };
  } catch(e) {
    return { suspeito:false, motivo:'' };
  }
}

// ── LOGS (Logs.gs) ─────────────────────────────────────────

/**
 * Registra log de forma assíncrona (sem LockService) para não
 * bloquear operações de chat com 30+ usuários simultâneos.
 */
function registrarLogSistema(tipo, usuario, acao, detalhes) {
  try {
    var aba = obterAbaPorNome(ABA_LOGS);
    if (!aba) {
      var p = obterPlanilhaChat();
      aba = p.insertSheet(ABA_LOGS);
      aplicarCabecalhoEAjustes(aba, obterEstruturaAbas().LogsSistema.headers, null);
      formatarLinhaCabecalho(aba, 5);
    }
    aba.appendRow([new Date(), String(tipo||''), String(usuario||''), String(acao||''), String(detalhes||'')]);

    // Manter apenas os últimos MAX_LOGS_RETENCAO em batch eficiente
    var ultima = aba.getLastRow();
    if (ultima > MAX_LOGS_RETENCAO + 1) {
      aba.deleteRows(2, ultima - MAX_LOGS_RETENCAO - 1);
    }
    SpreadsheetApp.flush();
  } catch(e) {
    Logger.log('Log falhou silenciosamente: ' + e.message);
  }
}

function obterLogsSistema(limite) {
  try {
    var max = Math.min(limite || LOGS_RECENTES_LIMITE, 200);
    var aba = obterAbaPorNome(ABA_LOGS);
    if (!aba || aba.getLastRow() < 2) return [];
    var dados = aba.getDataRange().getValues();
    var logs = [], inicio = Math.max(1, dados.length - max);
    for (var i = dados.length - 1; i >= inicio; i--) {
      if (!dados[i][0]) continue;
      logs.push({
        dataHora: formatarDataLog(dados[i][0]),
        tipo:     String(dados[i][1]),
        usuario:  String(dados[i][2]),
        acao:     String(dados[i][3]),
        detalhes: String(dados[i][4])
      });
    }
    return logs;
  } catch(e) { return []; }
}

function obterLogsPorTipo(tipo, limite) {
  try {
    var max = limite || LOGS_RECENTES_LIMITE;
    var aba = obterAbaPorNome(ABA_LOGS);
    if (!aba || aba.getLastRow() < 2) return [];
    var dados = aba.getDataRange().getValues();
    var logs = [], cnt = 0, tp = String(tipo).toUpperCase().trim();
    for (var i = dados.length - 1; i >= 1 && cnt < max; i--) {
      if (String(dados[i][1]||'').toUpperCase().trim() === tp) {
        logs.push({ dataHora:formatarDataLog(dados[i][0]), tipo:String(dados[i][1]),
                    usuario:String(dados[i][2]), acao:String(dados[i][3]), detalhes:String(dados[i][4]) });
        cnt++;
      }
    }
    return logs;
  } catch(e) { return []; }
}

function obterLogsErro(l)  { return obterLogsPorTipo('ERRO', l); }
function obterLogsAdmin(l) { return obterLogsPorTipo('ADMIN', l); }
function obterLogsChat(l)  { return obterLogsPorTipo('CHAT', l); }

function limparLogsAntigos(dias) {
  try {
    var limite = new Date();
    limite.setDate(limite.getDate() - (dias || 7));
    var aba = obterAbaPorNome(ABA_LOGS);
    if (!aba || aba.getLastRow() < 2) return 0;
    var dados = aba.getDataRange().getValues();
    var cab = dados[0];
    var filtrado = dados.slice(1).filter(function(r) {
      var d = r[0] instanceof Date ? r[0] : new Date(r[0]);
      return d >= limite;
    });
    var removidos = dados.length - 1 - filtrado.length;
    if (removidos > 0) {
      aba.clearContent();
      var nova = [cab].concat(filtrado);
      aba.getRange(1,1,nova.length,cab.length).setValues(nova);
      SpreadsheetApp.flush();
    }
    return removidos;
  } catch(e) { return 0; }
}

function exportarLogs(limite) {
  try {
    var logs = obterLogsSistema(limite || 1000);
    return JSON.stringify({ exportadoEm: new Date().toISOString(), total: logs.length, logs: logs }, null, 2);
  } catch(e) { return JSON.stringify({ erro: e.message }); }
}

// ── VERIFICAÇÃO DO SISTEMA (VerificacaoSistema.gs) ──────────

function verificarSistemaCompleto() {
  var r = { timestamp:new Date().toLocaleString(), versao:SISTEMA_VERSAO, erros:0, avisos:0, componentes:{} };
  var checks = {
    planilha:  _chkPlanilha,
    abas:      _chkAbas,
    constantes:_chkConstantes,
    cache:     _chkCache,
    email:     _chkEmail
  };
  Object.keys(checks).forEach(function(k) {
    try { r.componentes[k] = checks[k](); } catch(e) { r.componentes[k] = { ok:false, erro:e.message }; }
    if (!r.componentes[k].ok) r.erros++;
  });
  return r;
}

function _chkEmail() {
  var ativo   = '';
  var efetivo = '';
  try { ativo   = Session.getActiveUser().getEmail();    } catch(x){}
  try { efetivo = Session.getEffectiveUser().getEmail(); } catch(x){}

  if (!ativo) {
    return {
      ok:    false,
      erro:  'Session.getActiveUser() vazio — WebApp provavelmente configurado como acesso anônimo. ' +
             'Redeply com "Qualquer pessoa com conta Google" ou "Qualquer pessoa da organização".',
      ativo:   ativo,
      efetivo: efetivo
    };
  }

  if (ativo === efetivo) {
    // Podem ser iguais se o próprio dono está acessando — não é erro
    return { ok:true, ativo:ativo, efetivo:efetivo, aviso:'Email ativo = efetivo (normal se for o dono acessando)' };
  }

  return { ok:true, ativo:ativo, efetivo:efetivo };
}

function _chkPlanilha() {
  var p = obterPlanilhaChat();
  if (!p) return { ok:false, erro:'Planilha inacessível.' };
  if (p.getId() !== SPREADSHEET_ID) return { ok:false, erro:'ID não confere.' };
  return { ok:true };
}

function _chkAbas() {
  var p = obterPlanilhaChat();
  var est = obterEstruturaAbas();
  var faltando = Object.keys(est).filter(function(n){ return !p.getSheetByName(n); });
  if (faltando.length) return { ok:false, erro:'Faltando: '+faltando.join(', '), faltando:faltando };
  return { ok:true };
}

function _chkConstantes() {
  var erros = [];
  if (!SPREADSHEET_ID) erros.push('SPREADSHEET_ID');
  if (!SISTEMA_VERSAO)  erros.push('SISTEMA_VERSAO');
  if (!getSenhaAdmin())     erros.push('SENHA_ADMIN');
  if (erros.length) return { ok:false, erro:'Undefined: '+erros.join(', ') };
  return { ok:true };
}

function _chkCache() {
  var c = CacheService.getScriptCache();
  c.put('_test','ok',30);
  if (c.get('_test') !== 'ok') return { ok:false, erro:'Cache não funciona.' };
  c.remove('_test');
  return { ok:true };
}

function gerarRelatorioDiagnostico() {
  var v = verificarSistemaCompleto();
  var linhas = ['=== DIAGNÓSTICO ===', 'Data: '+v.timestamp, 'Versão: '+v.versao, 'Erros: '+v.erros, ''];
  Object.keys(v.componentes).forEach(function(k) {
    var c = v.componentes[k];
    linhas.push(k.toUpperCase() + ': ' + (c.ok ? '✅ OK' : '❌ ' + c.erro));
    if (k === 'email') {
      linhas.push('   getActiveUser():    ' + (c.ativo   || '(vazio)'));
      linhas.push('   getEffectiveUser(): ' + (c.efetivo || '(vazio)'));
      if (c.aviso) linhas.push('   ⚠️ ' + c.aviso);
    }
  });
  linhas.push('');
  linhas.push('=== CONFIGURAÇÃO NECESSÁRIA ===');
  linhas.push('Ao fazer deploy do WebApp:');
  linhas.push('  Executar como: EU (seu email)');
  linhas.push('  Quem tem acesso: Qualquer pessoa com conta Google');
  linhas.push('  OU: Qualquer pessoa da organização');
  linhas.push('  NÃO usar: Qualquer pessoa (inclui anônimos)');
  return linhas.join('\n');
}

function executarDiagnostico() {
  var r = gerarRelatorioDiagnostico();
  Logger.log(r);
  return r;
}

/**
 * Função de teste rápido — execute no Apps Script para verificar emails.
 * Mostra o email de quem está executando.
 */
function testarCapturadeEmail() {
  Logger.log('=== TESTE DE CAPTURA DE EMAIL ===');
  Logger.log('getActiveUser().getEmail():    ' + Session.getActiveUser().getEmail());
  Logger.log('getEffectiveUser().getEmail(): ' + Session.getEffectiveUser().getEmail());
  Logger.log('');
  Logger.log('Se os dois forem iguais e for seu email, é porque VOCÊ está executando.');
  Logger.log('Se getActiveUser() retornar vazio, o WebApp está configurado como anônimo.');
  Logger.log('');
  Logger.log('SOLUÇÃO: Redeply com "Qualquer pessoa com conta Google"');
}
