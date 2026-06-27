// ============================================================
// UsuariosGrupos.gs — Gestão de Usuários e Grupos (Consolidado)
// Consolidado de: Usuarios.gs + Grupos.gs
// ============================================================

// ── USUÁRIOS (Usuarios.gs) ───────────────────────────────────

/** 
 * Obtém o email do usuário em contexto de google.script.run.
 * Nota: em deploys "Executar como: EU", getActiveUser() retorna vazio.
 * O email real vem do doGet via window._EMAIL_SESSAO → emailHint.
 */
function _tentarObterEmail() {
  try {
    var ativo = Session.getActiveUser().getEmail();
    if (ativo && ativo.indexOf('@') > 0) return ativo;
  } catch(x){}
  return '';
}

/**
 * Captura o email do usuário atual e vincula ao nome informado.
 *
 * ⚠️ REQUER: Deploy configurado como "Executar como: Usuário que acessa o app"
 * Com "Executar como: EU", getActiveUser() retorna '' para outros usuários.
 */
function vincularEmailAutomatico(nome) {
  var email = '';

  // Session.getActiveUser — único método confiável
  try {
    var ativo = Session.getActiveUser().getEmail();
    if (ativo && ativo.indexOf('@') > 0) email = ativo;
  } catch(x){}

  if (!email) {
    return JSON.stringify({
      ok: false,
      erro: 'Não foi possível identificar seu email automaticamente.\n\n' +
            'Isso ocorre quando o sistema está configurado como "Executar como: EU (dono)".\n\n' +
            'Solução: o administrador deve reconfigurar o deploy como\n' +
            '"Executar como: Usuário que acessa o app".'
    });
  }

  if (nome && nome.trim().length >= 2) {
    var resultado = JSON.parse(vincularUsuarioNome(email, nome.trim(), false));
    return JSON.stringify({ ok: resultado.ok, email: email, nome: nome.trim(), erro: resultado.erro });
  }

  return JSON.stringify({ ok: true, email: email, nome: '' });
}

/**
 * Verifica se o email passado é de fato o usuário atual (não o dono do script).
 * Usado para validar que o frontend não está mandando email errado.
 */
function verificarEmailUsuario(emailInformado) {
  var emailReal = _tentarObterEmail();
  if (!emailReal) return JSON.stringify({ ok:false, erro:'Não foi possível identificar sua conta Google.' });
  var emReal = normalizarEmail(emailReal);
  var emInfo = normalizarEmail(emailInformado);
  if (emReal && emInfo && emReal !== emInfo) {
    // Email informado não bate com email real — usar o real
    return JSON.stringify({ ok:true, email:emailReal, corrigido:true });
  }
  return JSON.stringify({ ok:true, email:emailReal, corrigido:false });
}

// ── Vínculo / cadastro ────────────────────────────────────

function vincularUsuarioNome(email, nome, forcar) {
  var em = normalizarEmail(email);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  var nm = String(nome||'').trim();
  if (!nm || nm.length < 2) return JSON.stringify({ ok:false, erro:'Nome muito curto.' });

  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(4000);
    var aba = _garantirAbaUsuarios();
    var dados = aba.getDataRange().getValues();
    var linha = -1;
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).toLowerCase().trim() === em) { linha = i+1; break; }
    }
    var agora = new Date().toLocaleString();
    if (linha > 0) {
      var nomeAtual = String(dados[linha-1][1]||'').trim();
      if (nomeAtual.toLowerCase() === nm.toLowerCase() && !forcar)
        return JSON.stringify({ ok:true, nome:nomeAtual, jaVinculado:true });
      aba.getRange(linha,2).setValue(nm);
      aba.getRange(linha,4).setValue(agora);
    } else {
      aba.appendRow([em, nm, agora, agora, 'Ativo', '', '']);
    }
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(ckUsuarios());
    registrarLogSistema('USUARIO', nm, 'Vinculado', em);
    return JSON.stringify({ ok:true, nome:nm });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

// ── Perfil ────────────────────────────────────────────────

function atualizarPerfilUsuario(email, nome, status, avatar, bio) {
  var em = normalizarEmail(email);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(4000);
    var aba = _garantirAbaUsuarios();
    var dados = aba.getDataRange().getValues();
    var linha = -1;
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).toLowerCase().trim() === em) { linha = i+1; break; }
    }
    if (linha === -1) return JSON.stringify({ ok:false, erro:'Usuário não encontrado.' });

    // Nome NÃO é alterado aqui — mudança de nome exige pedido de troca aprovado pelo admin.
    // Apenas status, avatar e bio podem ser atualizados livremente.
    if (status) aba.getRange(linha,5).setValue(String(status).trim());
    if (avatar) aba.getRange(linha,6).setValue(String(avatar).trim());
    if (bio !== undefined && bio !== null) aba.getRange(linha,7).setValue(String(bio).trim());
    aba.getRange(linha,4).setValue(new Date().toLocaleString());
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(ckUsuarios());
    // Invalidar cache de usuários otimizado
    try {
      var cache = CacheService.getScriptCache();
      cache.remove('sonne_mapa_usuarios');
    } catch(e){}
    return JSON.stringify({ ok:true });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

function obterPerfilCompleto(email) {
  var em = normalizarEmail(email);
  if (!em) return JSON.stringify({ encontrado:false });
  try {
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return JSON.stringify({ encontrado:false });
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).toLowerCase().trim() === em) {
        return JSON.stringify({
          encontrado:true, email:em,
          nome:      String(dados[i][1]||'').trim(),
          cadastro:  String(dados[i][2]||'').trim(),
          acesso:    String(dados[i][3]||'').trim(),
          status:    String(dados[i][4]||'').trim(),
          avatar:    String(dados[i][5]||'').trim(),
          bio:       String(dados[i][6]||'').trim()
        });
      }
    }
    return JSON.stringify({ encontrado:false });
  } catch(e) { return JSON.stringify({ encontrado:false }); }
}

// ── Disponibilidade de nome ───────────────────────────────

function verificarDisponibilidadeNome(nome) {
  var nm = String(nome||'').trim();
  if (!nm || nm.length < 2) return JSON.stringify({ disponivel:false, motivo:'Nome muito curto.' });
  try {
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return JSON.stringify({ disponivel:true, motivo:'' });
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][1]||'').trim().toLowerCase() === nm.toLowerCase())
        return JSON.stringify({ disponivel:false, motivo:'Nome já em uso.' });
    }
    return JSON.stringify({ disponivel:true, motivo:'' });
  } catch(e) { return JSON.stringify({ disponivel:true, motivo:'' }); }
}

// ── Presença online (heartbeat) ───────────────────────────

function heartbeatPresenca(nome, email) {
  try {
    registrarAtividade(nome, email);
    return JSON.stringify({ ok:true, ts: Date.now() });
  } catch(e) { return JSON.stringify({ ok:false }); }
}

function registrarAtividade(nome, email) {
  var cache = CacheService.getScriptCache();
  // Sempre atualiza o cache de presença (leve)
  cache.put(ckOnline(nome), 'sim', CACHE_TTL_ONLINE);

  // Atualizar planilha com debounce por email (máx 1x por minuto)
  var em = normalizarEmail(email);
  if (!em) return;
  var ckDb = 'hb_db_' + em.replace('@','_').replace('.','_');
  if (cache.get(ckDb)) return; // já atualizou recentemente
  cache.put(ckDb, '1', 60); // debounce de 60 segundos

  try {
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return;
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).toLowerCase().trim() === em) {
        aba.getRange(i+1, 4).setValue(new Date().toLocaleString());
        break;
      }
    }
  } catch(e) {}
}

function obterUsuariosOnline() {
  try {
    var cache = CacheService.getScriptCache();
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return JSON.stringify([]);
    var dados = aba.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < dados.length; i++) {
      var nm = String(dados[i][1]||'').trim();
      if (!nm) continue;
      if (cache.get(ckOnline(nm)) === 'sim') {
        lista.push({ nome:nm, email:String(dados[i][0]||'').trim() });
      }
    }
    return JSON.stringify(lista);
  } catch(e) { return JSON.stringify([]); }
}

// ── Lista de usuários (com cache) ─────────────────────────

function listarTodosUsuarios() {
  try {
    var cache = CacheService.getScriptCache();
    var ck = ckUsuarios();
    var raw = cache.get(ck);
    if (raw) return raw;
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return JSON.stringify([]);
    var dados = aba.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < dados.length; i++) {
      lista.push({
        email:    String(dados[i][0]||'').trim(),
        nome:     String(dados[i][1]||'').trim(),
        cadastro: String(dados[i][2]||'').trim(),
        acesso:   String(dados[i][3]||'').trim(),
        status:   String(dados[i][4]||'').trim(),
        avatar:   String(dados[i][5]||'').trim(),
        bio:      String(dados[i][6]||'').trim()
      });
    }
    var json = JSON.stringify(lista);
    _cachePutSafe(cache, ck, json, CACHE_TTL_USUARIOS);
    return json;
  } catch(e) { return JSON.stringify([]); }
}

// ── Pedidos de troca de nome ──────────────────────────────

function solicitarAlteracaoNome(email, nomeAtual, nomeNovo) {
  var em = normalizarEmail(email);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  var na = String(nomeAtual||'').trim(), nn = String(nomeNovo||'').trim();
  if (na.toLowerCase() === nn.toLowerCase()) return JSON.stringify({ ok:false, erro:'Nome igual ao atual.' });
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(4000);
    var aba = _garantirAbaPedidos();
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][2]||'').trim() === 'Pendente' && String(dados[i][4]||'').toLowerCase().trim() === em)
        return JSON.stringify({ ok:false, erro:'Já existe pedido pendente.' });
    }
    aba.appendRow([na, nn, 'Pendente', new Date().toLocaleString(), em]);
    SpreadsheetApp.flush();
    return JSON.stringify({ ok:true });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  } finally {
    if (trava.hasLock()) trava.releaseLock();
  }
}

function checarStatusPedido(nome, email) {
  var em = normalizarEmail(email);
  if (!em) return JSON.stringify({ status:'Erro' });
  try {
    var aba = obterAbaPorNome(ABA_PEDIDOS);
    if (!aba) return JSON.stringify({ status:'Nenhum' });
    var dados = aba.getDataRange().getValues();
    // Retornar o pedido mais recente do usuário (última linha encontrada)
    var ultimo = null;
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][4]||'').toLowerCase().trim() === em) {
        ultimo = {
          status:    String(dados[i][2]||''),
          nomeAtual: String(dados[i][0]||''),
          nomeNovo:  String(dados[i][1]||''),
          dataHora:  String(dados[i][3]||'')
        };
      }
    }
    if (ultimo) return JSON.stringify(ultimo);
    return JSON.stringify({ status:'Nenhum' });
  } catch(e) { return JSON.stringify({ status:'Erro' }); }
}

// ── GRUPOS (Grupos.gs) ─────────────────────────────────────

// ── Criar grupo (direto — usado pelo admin do sistema) ────
function criarGrupo(nomeGrupo, descricao, criadorEmail, icone) {
  try {
    var aba = _garantirAbaGrupos();
    var idGrupo = 'grupo_' + Date.now();
    var agora   = new Date().toLocaleString();
    var em      = String(criadorEmail||'').trim();
    // col: IdGrupo | NomeGrupo | Descricao | Criador | DataCriacao | Membros | Icone | AdminGrupo | StatusGrupo
    aba.appendRow([idGrupo, String(nomeGrupo||''), String(descricao||''),
                   em, agora, em, String(icone||'👥'), em, 'ATIVO']);
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(ckGrupos());
    registrarLogSistema('GRUPO', em, 'Grupo criado', nomeGrupo);
    return JSON.stringify({ ok:true, grupo:{ id:idGrupo, nome:nomeGrupo, descricao:descricao, criador:em, icone:icone||'👥' } });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

// ── Solicitar criação de grupo (fluxo normal — aguarda aprovação) ──
function solicitarCriacaoGrupo(nomeGrupo, descricao, icone, criadorEmail, criadorNome, membrosJson) {
  try {
    var aba = _garantirAbaSolicitacoes();
    // Verificar se já existe solicitação pendente com o mesmo nome
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][1]||'').toLowerCase().trim() === String(nomeGrupo||'').toLowerCase().trim() &&
          String(dados[i][7]||'').toUpperCase() === 'PENDENTE') {
        return JSON.stringify({ ok:false, erro:'Já existe uma solicitação pendente com este nome.' });
      }
    }
    var id   = 'sol_' + Date.now();
    var agora = new Date().toLocaleString();
    var membros = membrosJson || criadorEmail; // ao menos o próprio criador
    aba.appendRow([id, String(nomeGrupo||''), String(descricao||''), String(icone||'👥'),
                   String(criadorEmail||''), String(criadorNome||''), String(membros||''),
                   'PENDENTE', agora, '']);
    SpreadsheetApp.flush();
    registrarLogSistema('GRUPO', criadorNome, 'Solicitacao de grupo', nomeGrupo);
    return JSON.stringify({ ok:true, id:id, status:'PENDENTE' });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

// ── Listar solicitações pendentes (para o admin) ──────────
function listarSolicitacoesGrupo() {
  try {
    var aba = _garantirAbaSolicitacoes();
    if (aba.getLastRow() < 2) return JSON.stringify([]);
    var dados = aba.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][7]||'').toUpperCase() === 'PENDENTE') {
        // Resolver nomes dos membros para exibição
        var membrosEmails = String(dados[i][6]||'').split(',').map(function(x){return x.trim();}).filter(Boolean);
        var membrosNomes  = _resolverNomesMembros(membrosEmails);
        lista.push({
          linha:        i + 1,
          id:           String(dados[i][0]||''),
          nome:         String(dados[i][1]||''),
          descricao:    String(dados[i][2]||''),
          icone:        String(dados[i][3]||'👥'),
          criadorEmail: String(dados[i][4]||''),
          criadorNome:  String(dados[i][5]||''),
          membros:      membrosEmails,
          membrosNomes: membrosNomes,
          status:       String(dados[i][7]||''),
          dataHora:     String(dados[i][8]||'')
        });
      }
    }
    return JSON.stringify(lista);
  } catch(e) { return JSON.stringify([]); }
}

// ── Responder solicitação (aprovar / recusar) ─────────────
function responderSolicitacaoGrupo(linha, decisao, motivo, solicitante) {
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(5000);
    var aba = _garantirAbaSolicitacoes();
    var row = aba.getRange(linha, 1, 1, 10).getValues()[0];
    var nomeGrupo   = String(row[1]||'');
    var descricao   = String(row[2]||'');
    var icone       = String(row[3]||'👥');
    var criadorEmail= String(row[4]||'');
    var membros     = String(row[6]||'');

    // Apenas admin pode aprovar grupos, moderadores não
    if (decisao.toUpperCase() === 'APROVADO' && !verificarSeAdmin(solicitante)) {
      return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode aprovar grupos.' });
    }

    // Atualizar status
    aba.getRange(linha, 8).setValue(decisao.toUpperCase());
    if (motivo) aba.getRange(linha, 10).setValue(String(motivo));
    SpreadsheetApp.flush();

    if (decisao.toUpperCase() === 'APROVADO') {
      // Criar o grupo de fato
      var aba2 = _garantirAbaGrupos();
      var idGrupo = 'grupo_' + Date.now();
      var agora   = new Date().toLocaleString();
      aba2.appendRow([idGrupo, nomeGrupo, descricao, criadorEmail,
                      agora, membros, icone, criadorEmail, 'ATIVO']);
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckGrupos());
      registrarLogSistema('GRUPO', solicitante || 'Admin', 'Grupo aprovado', nomeGrupo);
      return JSON.stringify({ ok:true, decisao:'APROVADO', idGrupo:idGrupo });
    } else {
      registrarLogSistema('GRUPO', solicitante || 'Admin', 'Grupo recusado', nomeGrupo + ' — ' + (motivo||''));
      return JSON.stringify({ ok:true, decisao:'RECUSADO' });
    }
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
  finally   { if (trava.hasLock()) trava.releaseLock(); }
}

// ── Checar status da solicitação do usuário ───────────────
function checarStatusSolicitacaoGrupo(criadorEmail) {
  try {
    var em  = String(criadorEmail||'').toLowerCase().trim();
    var aba = _garantirAbaSolicitacoes();
    if (aba.getLastRow() < 2) return JSON.stringify({ status:'Nenhum' });
    var dados = aba.getDataRange().getValues();
    // Retorna a mais recente
    for (var i = dados.length - 1; i >= 1; i--) {
      if (String(dados[i][4]||'').toLowerCase().trim() === em) {
        return JSON.stringify({
          status:    String(dados[i][7]||''),
          nome:      String(dados[i][1]||''),
          motivo:    String(dados[i][9]||''),
          dataHora:  String(dados[i][8]||'')
        });
      }
    }
    return JSON.stringify({ status:'Nenhum' });
  } catch(e) { return JSON.stringify({ status:'Erro' }); }
}

// ── Gerenciar membros do grupo ────────────────────────────

// Token lazy — calculado na primeira chamada para evitar erro de ordem de carregamento
var _ADMIN_TOKEN_CACHE = null;
function _getAdminToken() {
  if (!_ADMIN_TOKEN_CACHE) {
    try { _ADMIN_TOKEN_CACHE = 'SONNE_SYSTEM_ADMIN_' + getSenhaAdmin(); }
    catch(e) { _ADMIN_TOKEN_CACHE = 'SONNE_SYSTEM_ADMIN_FALLBACK'; }
  }
  return _ADMIN_TOKEN_CACHE;
}

function adicionarMembroGrupo(idGrupo, emailMembro, solicitante) {
  return _alterarMembro(idGrupo, emailMembro, solicitante, true);
}

function removerMembroGrupo(idGrupo, emailMembro, solicitante) {
  return _alterarMembro(idGrupo, emailMembro, solicitante, false);
}

// Verifica se solicitante é admin do sistema
function _isAdminSistema(solicitante) {
  if (!solicitante) return false;
  // Verificar token interno (lazy)
  try { if (solicitante === _getAdminToken()) return true; } catch(e){}
  // Verificar lista de admins configurada na planilha
  try {
    var lista = obterConfiguracao('EmailsAdmins') || '';
    if (lista) {
      var em = normalizarEmail(solicitante);
      if (em && lista.split(',').some(function(x){ return normalizarEmail(x) === em; })) return true;
    }
  } catch(e){}
  return false;
}

// Retorna array normalizado de admins do grupo (col 8, índice 7)
function _getAdminsGrupo(row) {
  return String(row[7]||row[3]||'').replace(/;/g, ',').split(',').map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
}

// Verifica se email é admin do grupo
function _isAdminDoGrupo(row, email) {
  var em = String(email||'').toLowerCase().trim();
  if (!em) return false;
  return _getAdminsGrupo(row).indexOf(em) !== -1;
}

// Altera membros (adicionar ou remover)
// Regra: admin do grupo OU admin do sistema
function _alterarMembro(idGrupo, emailMembro, solicitante, adicionar) {
  try {
    var aba   = _garantirAbaGrupos();
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) !== idGrupo) continue;

      var isAdminSist  = _isAdminSistema(solicitante);
      var isAdminGrupo = _isAdminDoGrupo(dados[i], solicitante);

      if (!isAdminSist && !isAdminGrupo)
        return JSON.stringify({ ok:false, erro:'Sem permissão. Apenas admins do grupo ou do sistema podem gerenciar membros.' });

      var membros = String(dados[i][5]||'').replace(/;/g, ',').split(',').map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
      var emNorm  = String(emailMembro||'').toLowerCase().trim();
      if (!emNorm) return JSON.stringify({ ok:false, erro:'Email inválido.' });

      var idx = membros.indexOf(emNorm);
      if (adicionar) {
        if (idx !== -1) return JSON.stringify({ ok:false, erro:'Usuário já é membro.' });
        membros.push(emNorm);
      } else {
        if (idx === -1) return JSON.stringify({ ok:false, erro:'Usuário não é membro deste grupo.' });
        membros.splice(idx, 1);
        // Se era admin do grupo, remover da lista de admins também
        var admins = _getAdminsGrupo(dados[i]);
        var criador = String(dados[i][3]||'').toLowerCase().trim();
        var aIdx = admins.indexOf(emNorm);
        if (aIdx !== -1 && emNorm !== criador) {
          admins.splice(aIdx, 1);
          aba.getRange(i+1, 8).setValue(admins.join(','));
        }
      }

      aba.getRange(i+1, 6).setValue(membros.join(','));
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckGrupos());
      registrarLogSistema('GRUPO', solicitante,
        adicionar ? 'Membro adicionado' : 'Membro removido',
        'Grupo:' + dados[i][1] + ' Membro:' + emailMembro);
      return JSON.stringify({ ok:true, totalMembros: membros.length });
    }
    return JSON.stringify({ ok:false, erro:'Grupo não encontrado.' });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

// ── Promover admin do grupo ───────────────────────────────
// Regra: admin do grupo OU admin do sistema pode promover
function promoverAdminGrupo(idGrupo, emailNovoAdmin, solicitante) {
  try {
    var aba   = _garantirAbaGrupos();
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) !== idGrupo) continue;

      var isAdminSist  = _isAdminSistema(solicitante);
      var isAdminGrupo = _isAdminDoGrupo(dados[i], solicitante);
      if (!isAdminSist && !isAdminGrupo)
        return JSON.stringify({ ok:false, erro:'Sem permissão para promover admins.' });

      // Precisa ser membro antes
      var membros = String(dados[i][5]||'').split(',').map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
      var emNorm  = String(emailNovoAdmin||'').toLowerCase().trim();
      if (membros.indexOf(emNorm) === -1)
        return JSON.stringify({ ok:false, erro:'O usuário precisa ser membro antes de ser promovido.' });

      var admins = _getAdminsGrupo(dados[i]);
      if (admins.indexOf(emNorm) !== -1)
        return JSON.stringify({ ok:false, erro:'Usuário já é admin deste grupo.' });

      admins.push(emNorm);
      aba.getRange(i+1, 8).setValue(admins.join(','));
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckGrupos());
      registrarLogSistema('GRUPO', solicitante, 'Admin de grupo promovido',
        'Grupo:' + dados[i][1] + ' NovoAdmin:' + emailNovoAdmin);
      return JSON.stringify({ ok:true });
    }
    return JSON.stringify({ ok:false, erro:'Grupo não encontrado.' });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

// ── Revogar admin do grupo ────────────────────────────────
// Regra: APENAS admin do sistema pode revogar. Criador original nunca perde.
function revogarAdminGrupo(idGrupo, emailAdmin, solicitante) {
  if (!_isAdminSistema(solicitante))
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode revogar admins de grupo.' });
  try {
    var aba   = _garantirAbaGrupos();
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) !== idGrupo) continue;

      var criador = String(dados[i][3]||'').toLowerCase().trim();
      var emNorm  = String(emailAdmin||'').toLowerCase().trim();
      if (emNorm === criador)
        return JSON.stringify({ ok:false, erro:'O criador original do grupo não pode ter sua permissão revogada.' });

      var admins = _getAdminsGrupo(dados[i]);
      var idx    = admins.indexOf(emNorm);
      if (idx === -1)
        return JSON.stringify({ ok:false, erro:'Usuário não é admin deste grupo.' });

      admins.splice(idx, 1);
      aba.getRange(i+1, 8).setValue(admins.join(','));
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckGrupos());
      registrarLogSistema('GRUPO', solicitante, 'Admin de grupo revogado',
        'Grupo:' + dados[i][1] + ' Admin:' + emailAdmin);
      return JSON.stringify({ ok:true });
    }
    return JSON.stringify({ ok:false, erro:'Grupo não encontrado.' });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

// ── Listar todos os usuários disponíveis para adicionar ───
function listarUsuariosParaMembros() {
  try {
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return JSON.stringify([]);
    var dados = aba.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < dados.length; i++) {
      var em = String(dados[i][0]||'').trim();
      var nm = String(dados[i][1]||'').trim();
      var st = String(dados[i][4]||'').toUpperCase();
      if (em && nm && st !== 'BLOQUEADO') {
        lista.push({ email:em, nome:nm, avatar:String(dados[i][5]||'👤').trim() });
      }
    }
    return JSON.stringify(lista);
  } catch(e) { return JSON.stringify([]); }
}

// ── Listar grupos do usuário ──────────────────────────────
function listarGruposUsuario(emailUsuario) {
  try {
    var todos = JSON.parse(_listarTodosGruposRaw());
    var em    = String(emailUsuario||'').toLowerCase().trim();
    
    // Obter contagem de não lidas
    var naoLidasData = JSON.parse(obterNaoLidas(emailUsuario));
    var porGrupo = naoLidasData.porGrupo || {};
    
    var grupos = todos.filter(function(g) {
      if (String(g.statusGrupo||'ATIVO').toUpperCase() !== 'ATIVO') return false;
      var membros = String(g.membros||'');
      if (membros.toLowerCase() === 'todos') return true;
      return membros.replace(/;/g, ',').split(',').some(function(m){ return m.trim().toLowerCase() === em; });
    }).map(function(g) {
      var membros    = String(g.membros||'');
      var ehTodos    = membros.toLowerCase() === 'todos';
      // Contar membros reais (não 'todos')
      var qtdMembros = ehTodos ? null : membros.replace(/;/g, ',').split(',').map(function(x){return x.trim();}).filter(Boolean).length;
      // Detectar se usuário é admin do grupo (multi-admin)
      var admins     = String(g.adminGrupo||g.criador||'').replace(/;/g, ',').split(',').map(function(x){return x.trim().toLowerCase();}).filter(Boolean);
      var euAdminGrupo = admins.indexOf(em) !== -1;
      // Contagem de não lidas para este grupo
      var grupoNaoLidas = porGrupo[g.id] || 0;
      return {
        id:           g.id,
        nome:         g.nome,
        descricao:    g.descricao,
        criador:      g.criador,
        dataCriacao:  g.dataCriacao,
        icone:        g.icone||'👥',
        adminGrupo:   String(g.adminGrupo||g.criador||''),
        admins:       admins,
        isAdminGrupo: euAdminGrupo,
        ehPublico:    ehTodos,
        totalMembros: ehTodos ? 'Todos' : qtdMembros,
        _naoLidas:    grupoNaoLidas
      };
    });
    return JSON.stringify({ ok:true, grupos:grupos });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function listarTodosGrupos() {
  try {
    return JSON.stringify({ ok:true, grupos: JSON.parse(_listarTodosGruposRaw()) });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function _listarTodosGruposRaw(forcar) {
  var cache = CacheService.getScriptCache();
  var ck = ckGrupos();
  if (!forcar) {
    var raw = cache.get(ck);
    if (raw) return raw;
  }
  var aba = obterAbaPorNome(ABA_GRUPOS);
  if (!aba || aba.getLastRow() < 2) {
    criarGrupoPadrao();
    aba = obterAbaPorNome(ABA_GRUPOS);
  }
  var dados = aba ? aba.getDataRange().getValues() : [];
  var lista = [];
  for (var i = 1; i < dados.length; i++) {
    lista.push({
      id:          dados[i][0], nome:       dados[i][1],
      descricao:   dados[i][2], criador:    dados[i][3],
      dataCriacao: dados[i][4], membros:    dados[i][5],
      icone:       dados[i][6]||'👥',
      adminGrupo:  dados[i][7]||dados[i][3],
      statusGrupo: dados[i][8]||'ATIVO'
    });
  }
  if (lista.length === 0) { criarGrupoPadrao(); }
  var json = JSON.stringify(lista);
  _cachePutSafe(cache, ck, json, CACHE_TTL_GRUPOS);
  return json;
}

function criarGrupoPadrao() {
  var aba = _garantirAbaGrupos();
  if (aba.getLastRow() > 1) return;
  aba.appendRow(['grupo_geral','Geral','Grupo padrão para todos os usuários',
                 'sistema@sonne', new Date().toLocaleString(), 'todos', '💬', 'sistema@sonne', 'ATIVO']);
  SpreadsheetApp.flush();
  CacheService.getScriptCache().remove(ckGrupos());
}

function deletarGrupo(idGrupo, solicitante) {
  try {
    var aba   = _garantirAbaGrupos();
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]) !== idGrupo) continue;
      var isAdminSist  = _isAdminSistema(solicitante);
      var isAdminGrupo = _isAdminDoGrupo(dados[i], solicitante);
      if (!isAdminSist && !isAdminGrupo)
        return JSON.stringify({ ok:false, erro:'Sem permissão.' });
      aba.deleteRow(i+1);
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove(ckGrupos());
      registrarLogSistema('GRUPO', solicitante, 'Grupo deletado', dados[i][1]);
      return JSON.stringify({ ok:true });
    }
    return JSON.stringify({ ok:false, erro:'Grupo não encontrado.' });
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function obterDetalhesGrupo(idGrupo, emailUsuario) {
  try {
    // Para obter detalhes, sempre lemos da planilha para garantir sincronismo
    var grupos = JSON.parse(_listarTodosGruposRaw(true));
    var g = grupos.filter(function(x){ return String(x.id) === String(idGrupo); })[0];
    if (!g) return JSON.stringify({ ok:false, erro:'Grupo não encontrado.' });

    // Verificar acesso com dados atualizados
    var emNorm = normalizarEmail(emailUsuario);
    var ehTodos = String(g.membros||'').toLowerCase() === 'todos';
    var isMembro = false;
    
    // Admin do sistema tem sempre acesso
    var isAdminSist = _isAdminSistema(emailUsuario);
    
    if (idGrupo === 'grupo_geral' || ehTodos || isAdminSist) {
      isMembro = true;
    } else {
      var membrosList = String(g.membros||'').replace(/;/g, ',').split(',').map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
      if (emNorm && membrosList.indexOf(emNorm) !== -1) {
        isMembro = true;
      }
    }

    if (!isMembro) {
      return JSON.stringify({ ok:false, erro:'Sem permissão para ver este grupo.' });
    }

    // Para grupos públicos, buscar TODOS os usuários ativos do sistema
    var membrosArr;
    var detalhados;
    if (ehTodos) {
      membrosArr = [];
      try {
        var abaU = obterAbaPorNome(ABA_USUARIOS);
        if (abaU) {
          var du = abaU.getDataRange().getValues();
          for (var i = 1; i < du.length; i++) {
            var em = String(du[i][0]||'').trim();
            var nm = String(du[i][1]||'').trim();
            var st = String(du[i][4]||'').toUpperCase();
            if (em && nm && st !== 'BLOQUEADO') {
              membrosArr.push(em);
              if (!detalhados) detalhados = [];
              detalhados.push({ email:em, nome:nm, avatar:String(du[i][5]||'👤').trim() });
            }
          }
        }
      } catch(x){}
      if (!detalhados) detalhados = [];
    } else {
      membrosArr = String(g.membros||'').replace(/;/g, ',').split(',').map(function(x){return x.trim();}).filter(Boolean);
      detalhados = _resolverNomesMembros(membrosArr);
    }

    // Normalizar lista de admins do grupo
    var admins = String(g.adminGrupo||g.criador||'').replace(/;/g, ',').split(',').map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);

    return JSON.stringify({ ok:true, grupo:{
      id:          g.id,
      nome:        g.nome,
      descricao:   g.descricao,
      criador:     g.criador,
      dataCriacao: g.dataCriacao,
      icone:       g.icone||'👥',
      adminGrupo:  String(g.adminGrupo||g.criador||''),
      admins:      admins,
      ehPublico:   ehTodos,
      totalMembros: ehTodos ? 'Todos' : membrosArr.length,
      membros:     detalhados
    }});
  } catch(e) { return JSON.stringify({ ok:false, erro:e.message }); }
}

function verificarMembroGrupo(idGrupo, emailUsuario) {
  try {
    var grupos = JSON.parse(_listarTodosGruposRaw());
    var g = grupos.filter(function(x){ return String(x.id) === String(idGrupo); })[0];
    if (!g) return false;
    var membros = String(g.membros||'');
    if (membros.toLowerCase() === 'todos') return true;
    var em = String(emailUsuario||'').toLowerCase().trim();
    return membros.replace(/;/g, ',').split(',').some(function(m){ return m.trim().toLowerCase() === em; });
  } catch(e) { return false; }
}

// ── Helpers (Usuarios e Grupos) ─────────────────────────────

function _resolverNomesMembros(emailsArr) {
  if (!emailsArr || !emailsArr.length) return [];
  try {
    var aba = obterAbaPorNome(ABA_USUARIOS);
    if (!aba) return emailsArr.map(function(e){ return { email:e, nome:e, avatar:'👤' }; });
    var du = aba.getDataRange().getValues();
    return emailsArr.map(function(em) {
      for (var k = 1; k < du.length; k++) {
        if (String(du[k][0]||'').toLowerCase().trim() === em.toLowerCase()) {
          return { email:du[k][0], nome:du[k][1]||em, avatar:du[k][5]||'👤' };
        }
      }
      return { email:em, nome:em, avatar:'👤' };
    });
  } catch(e) { return emailsArr.map(function(e){ return { email:e, nome:e, avatar:'👤' }; }); }
}

function _garantirAbaUsuarios() {
  var aba = obterAbaPorNome(ABA_USUARIOS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_USUARIOS);
    var est = obterEstruturaAbas().Usuarios;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
  }
  return aba;
}

function _garantirAbaPedidos() {
  var aba = obterAbaPorNome(ABA_PEDIDOS);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(ABA_PEDIDOS);
    var est = obterEstruturaAbas().PedidosNome;
    aplicarCabecalhoEAjustes(aba, est.headers, est.larguras);
    formatarLinhaCabecalho(aba, est.headers.length);
  }
  return aba;
}

function _garantirAbaSolicitacoes() {
  // Usa string literal como fallback para evitar erro se constante não estiver carregada
  var nomeAba = (typeof ABA_SOLICIT_GRUPO !== 'undefined') ? ABA_SOLICIT_GRUPO : 'SolicitacoesGrupo';
  var aba = obterAbaPorNome(nomeAba);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(nomeAba);
    // Headers inline — não depende de obterEstruturaAbas()
    var headers  = ['IdSolicitacao','NomeGrupo','Descricao','Icone','CriadorEmail','CriadorNome','Membros','Status','DataHora','MotivoRecusa'];
    var larguras = [220,180,250,80,220,140,400,100,160,250];
    aplicarCabecalhoEAjustes(aba, headers, larguras);
    formatarLinhaCabecalho(aba, headers.length);
  }
  return aba;
}

function _garantirAbaGrupos() {
  var nomeAba = (typeof ABA_GRUPOS !== 'undefined') ? ABA_GRUPOS : 'Grupos';
  var aba = obterAbaPorNome(nomeAba);
  if (!aba) {
    aba = obterPlanilhaChat().insertSheet(nomeAba);
    var headers  = ['IdGrupo','NomeGrupo','Descricao','Criador','DataCriacao','Membros','Icone','AdminGrupo','StatusGrupo'];
    var larguras = [200,180,250,180,160,400,80,200,100];
    aplicarCabecalhoEAjustes(aba, headers, larguras);
    formatarLinhaCabecalho(aba, headers.length);
  }
  return aba;
}
