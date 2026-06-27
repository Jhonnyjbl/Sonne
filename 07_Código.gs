// ============================================================
// Código.gs — Entry-points do WebApp (doGet + google.script.run)
// ============================================================

Logger.log('=== 07_Código.gs CARREGADO ===');

/**
 * Ponto de entrada do WebApp.
 *
 * ✅ CONFIGURAÇÃO CORRETA DO DEPLOY:
 *   - Executar como: Usuário que acessa o app
 *   - Quem tem acesso: Qualquer pessoa da organização
 *
 * Com essa configuração:
 *   - Session.getActiveUser() retorna o email do visitante ✅
 *   - O script acessa a planilha em nome do visitante
 *   - O visitante precisa ter a planilha compartilhada como Editor
 *     (feito automaticamente pela função abaixo)
 *
 * A função concederAcessoPlanilha() garante acesso automático
 * ao primeiro acesso de cada usuário.
 */
function doGet(e) {
  Logger.log('=== doGet CHAMADO ===');
  Logger.log('Parâmetros: ' + JSON.stringify(e.parameter));
  try { autoRepararEstrutura(); } catch(x) {}

  // Capturar email — funciona com deploy "Executar como: Usuário que acessa"
  var emailUsuario = '';
  try {
    var ativo = Session.getActiveUser().getEmail();
    Logger.log('Email capturado via Session.getActiveUser(): ' + ativo);
    if (ativo && ativo.indexOf('@') > 0) emailUsuario = ativo;
  } catch(x){
    Logger.log('Erro ao capturar email: ' + x.message);
  }
  
  Logger.log('Email final a ser injetado: ' + emailUsuario);

  // Se capturou email, garantir acesso à planilha automaticamente
  if (emailUsuario) {
    try { _concederAcessoSeNecessario(emailUsuario); } catch(x){}
  }

  garantirEstruturaPlanilha();

  var html     = HtmlService.createHtmlOutputFromFile('Interface');
  var conteudo = html.getContent();
  var injetar  = '<script>window._EMAIL_SESSAO = ' + JSON.stringify(emailUsuario) + ';</script>';
  Logger.log('Injetando script: ' + injetar);
  conteudo = conteudo.replace('<body>', '<body>' + injetar);
  html.setContent(conteudo);

  return html
    .setTitle(SISTEMA_NOME + ' Chat')
    .addMetaTag('viewport','width=device-width,initial-scale=1,maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Concede acesso de Editor à planilha automaticamente para o usuário.
 * Executado apenas uma vez por usuário (verifica cache).
 * Requer que o script seja executado como dono (que tem permissão de compartilhar).
 *
 * NOTA: Esta função usa DriveApp que requer escopo de Drive.
 * Adicione ao appsscript.json:
 *   "https://www.googleapis.com/auth/drive"
 */
function _concederAcessoSeNecessario(email) {
  var cache = CacheService.getScriptCache();
  var ck    = 'acesso_' + email.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (cache.get(ck)) return; // já concedeu recentemente

  try {
    var arquivo = DriveApp.getFileById(SPREADSHEET_ID);
    var editores = arquivo.getEditors().map(function(u){ return u.getEmail().toLowerCase(); });
    if (editores.indexOf(email.toLowerCase()) === -1) {
      arquivo.addEditor(email);
    }
    cache.put(ck, '1', 86400); // 24h — não verificar de novo tão cedo
  } catch(x) {
    // Falha silenciosa — pode não ter permissão de Drive
  }
}

// ── Inicialização ─────────────────────────────────────────

/**
 * Retorna dados iniciais de sessão.
 * O emailHint é enviado pelo frontend a partir do window._EMAIL_SESSAO
 * que foi injetado no doGet (único contexto que captura email confiável).
 */
function obterDadosIniciais(emailHint) {
  try {
    Logger.log('=== obterDadosIniciais CHAMADO ===');
    Logger.log('emailHint: ' + emailHint);
    
    // Executar limpeza automática periodicamente (a cada 24h)
    try { executarLimpezaAutomatica(); } catch(x){}
    
    // NÃO chama garantirEstruturaPlanilha() aqui — já foi chamado no doGet.
    // Chamar novamente duplica o custo de inicialização e é a causa do splash lento.

    // Tentar capturar email: sessão atual > hint do doGet > vazio
    var email = _tentarObterEmail();
    if (!email && emailHint && emailHint.indexOf('@') > 0) {
      email = String(emailHint).trim().toLowerCase();
    }
    
    Logger.log('Email final: ' + email);

    // Verificar punição ativa ANTES de carregar dados
    if (email) {
      var punicao = JSON.parse(verificarPunicaoAtiva(email));
      Logger.log('Punição verificada: ' + JSON.stringify(punicao));
      if (punicao.punicao) {
        var tipo = punicao.punicao.tipo;
        Logger.log('Usuário punido - Tipo: ' + tipo);
        // Retornar erro para impedir acesso
        return JSON.stringify({
          ok: false,
          erro: 'punicao',
          tipoPunicao: tipo,
          dataFim: punicao.punicao.dataFim,
          punicao: punicao.punicao
        });
      }
    }

    // Carregar dados em paralelo (cada um com try/catch independente)
    var grupos = { grupos: [] };
    try { grupos = JSON.parse(email ? listarGruposUsuario(email) : listarTodosGrupos()); } catch(x) {}

    var bloq = { bloqueado: false };
    try { bloq = JSON.parse(obterStatusBloqueio()); } catch(x) {}

    var notif = { notificacao: { ativa: false } };
    try { notif = JSON.parse(obterNotificacaoAtiva(email)); } catch(x) {}

    var perfil = { encontrado: false };
    try { if (email) perfil = JSON.parse(obterPerfilCompleto(email)); } catch(x) {}

    return JSON.stringify({
      ok:          true,
      email:       email,
      emailFonte:  _tentarObterEmail() ? 'sessao' : (emailHint ? 'doGet' : 'nenhum'),
      perfil:      perfil,
      grupos:      grupos.grupos || [],
      bloqueio:    bloq,
      notificacao: notif.notificacao || { ativa:false },
      versao:      SISTEMA_VERSAO,
      reacoes:     obterListaReacoes(),
      emojis:      obterListaEmojis()
    });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Polling otimizado ─────────────────────────────────────

/**
 * Busca apenas mensagens novas desde `tsUltima` (timestamp ms).
 * Reduz drasticamente a carga em 30+ usuários simultâneos.
 */
function pollMensagens(nomeUsuario, idGrupo, tsUltima) {
  return carregarHistorico(nomeUsuario, idGrupo, tsUltima || 0);
}

// ── Wrapper público para google.script.run ────────────────
// Todos os métodos abaixo são chamados diretamente pelo front-end.

function wEnviarMensagem(nome, texto, destino, email, idResposta) {
  Logger.log('wEnviarMensagem chamado: nome=' + nome + ', texto=' + texto + ', destino=' + destino + ', email=' + email);
  var resultado = salvarMensagem(nome, texto, destino, email, idResposta);
  Logger.log('wEnviarMensagem resultado: ' + resultado);
  return resultado;
}

function wCarregarHistorico(nome, grupo, tsUltima, email) {
  return carregarHistorico(nome, grupo, tsUltima || 0, 1, 50, email);
}

function wMarcarLido(emailUsuario, canal) {
  marcarComoLido(emailUsuario, canal);
  return JSON.stringify({ ok:true });
}

function wApagarMensagem(idRef, nome, verJson) {
  return apagarMinhaMensagem(idRef, nome, verJson);
}

function wEditarMensagem(idRef, nome, novoTexto, verJson) {
  return editarMensagem(idRef, nome, novoTexto, verJson);
}

function wReagir(idRef, nome, emoji, verJson) {
  return adicionarReacao(idRef, nome, emoji, verJson);
}

function wDigitando(canal, nome) {
  return notificarDigitando(canal, nome);
}

function wHeartbeat(nome, email) {
  return heartbeatPresenca(nome, email);
}

function wVincularEmailAutomatico(nome) {
  return vincularEmailAutomatico(nome);
}

function wValidarEVincularEmail(email, nome) {
  // validarEVincularEmail = alias para vincularUsuarioNome com validação extra
  var em = normalizarEmail(email);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  if (!nome || String(nome).trim().length < 2) return JSON.stringify({ ok:false, erro:'Nome muito curto.' });
  try {
    var blk = JSON.parse(verificarUsuarioBloqueado(em));
    if (blk.bloqueado) return JSON.stringify({ ok:false, erro:'Conta bloqueada. Contate o administrador.' });
  } catch(x){}
  return vincularUsuarioNome(em, String(nome).trim(), false);
}

function wVincularUsuario(email, nome) {
  // Tentar pegar email da sessão atual primeiro
  var emailSessao = _tentarObterEmail();
  // Usar: sessão real > email do hint (doGet) > email enviado pelo frontend
  var emailFinal = emailSessao || (email && email.indexOf('@') > 0 ? email : '');
  if (!emailFinal) return JSON.stringify({ ok:false, erro:'Não foi possível identificar sua conta Google.' });
  return vincularUsuarioNome(emailFinal, nome, false);
}

function wVerificarEmailUsuario(emailInformado) {
  return verificarEmailUsuario(emailInformado);
}

function wObterEmailSessao() {
  // Tenta Session.getActiveUser() — funciona com deploy "Executar como: Usuário que acessa"
  var email = '';
  try {
    var ativo = Session.getActiveUser().getEmail();
    if (ativo && ativo.indexOf('@') > 0) email = ativo;
  } catch(x){}
  return JSON.stringify({ ok: !!email, email: email });
}

function wValidarNome(nome, email) {
  return validarNomeDisponivel(nome, email);
}

function wVerificarNomeDisponivel(nome) {
  return verificarDisponibilidadeNome(nome);
}

function wObterPerfil(email) {
  return obterPerfilCompleto(email);
}

function wAtualizarPerfil(email, nome, status, avatar, bio) {
  return atualizarPerfilUsuario(email, nome, status, avatar, bio);
}

function wSolicitarTrocaNome(email, nomeAtual, nomeNovo) {
  return solicitarAlteracaoNome(email, nomeAtual, nomeNovo);
}

function wStatusPedido(nome, email) {
  return checarStatusPedido(nome, email);
}

function wListarGrupos(email) {
  return listarGruposUsuario(email);
}

function wCriarGrupo(nome, desc, icone, criador) {
  return criarGrupo(nome, desc, criador, icone);
}

function wObterDetalhesGrupo(idGrupo, email) {
  return obterDetalhesGrupo(idGrupo, email);
}

function wBuscarMensagens(idGrupo, query, email) {
  return buscarMensagens(idGrupo, query, email);
}

function wNotificacaoAtiva(email) {
  return obterNotificacaoAtiva(email);
}

function wFecharNotificacao(id, email) {
  return registrarUsuarioFechouNotificacao(id, email);
}

function wObterNotifPessoal(email) {
  return obterNotifPessoal(email);
}

function wStatusBloqueio() {
  return obterStatusBloqueio();
}

function wMensagemFixada(idGrupo, email) {
  return obterMensagemFixada(idGrupo, email);
}

function wUsuariosOnline() {
  return obterUsuariosOnline();
}

// ── Admin ─────────────────────────────────────────────────

function wVerificarAdmin(email, senha) {
  return verificarAdmin(email, senha);
}

function wPainelAdmin() {
  return obterPainelAdminCompleto();
}

function wEstatisticas() {
  return JSON.stringify(obterEstatisticasSistema());
}

function wBloquearUsuario(email, motivo, solicitante) {
  return bloquearUsuario(email, motivo, solicitante);
}

function wDesbloquearUsuario(email, solicitante) {
  return desbloquearUsuario(email, solicitante);
}

function wListarUsuarios() {
  return listarTodosUsuarios();
}

function wPedidosPendentes() {
  return JSON.stringify(listarPedidosPendentes());
}

function wResponderPedido(linha, decisao, solicitante) {
  return responderPedidoNome(linha, decisao, solicitante);
}

function wEnviarNotificacao(msg, duracao, tipo) {
  return salvarNotificacao(msg, duracao, tipo);
}

function wAtivarBloqueio(msg, previsao, tipo) {
  return ativarBloqueioSistema(msg, previsao, tipo);
}

function wDesativarBloqueio() {
  return desativarBloqueioSistema();
}

function wAdminCriarGrupo(nome, desc, icone, senha, emailAdmin) {
  return adminCriarGrupo(nome, desc, icone, senha, emailAdmin || '');
}

function wAdminDeletarGrupo(id, senha, emailAdmin) {
  return adminDeletarGrupo(id, senha, emailAdmin);
}

function wFixarMensagem(idMsg, emailAdmin, idGrupo) {
  return fixarMensagem(idMsg, emailAdmin, idGrupo);
}

function wDesfixarMensagem(idMsg, emailAdmin) {
  return desfixarMensagem(idMsg, emailAdmin);
}

function wExportarLogs(limite) {
  return exportarLogs(limite);
}

function wExportarDados() {
  return exportarDadosAdmin();
}

function wLimparCache() {
  return limparCacheSistema();
}

// ── Wrappers para busca avançada ──────────────────────────────
function wBuscarMensagensAvancada(termo, filtros, emailUsuario) {
  return buscarMensagensAvancada(termo, filtros, emailUsuario);
}

function wBuscarMensagensPrivadasAvancada(termo, filtros, emailUsuario) {
  return buscarMensagensPrivadasAvancada(termo, filtros, emailUsuario);
}

// ── Wrapper para comandos de chat ────────────────────────────
function wProcessarComandoChat(mensagem, idGrupo, emailUsuario, nomeUsuario) {
  return processarComandoChat(mensagem, idGrupo, emailUsuario, nomeUsuario);
}

// ── Wrappers para agendamento de mensagens ────────────────────
function wAgendarMensagem(emailUsuario, nomeUsuario, destino, mensagem, dataAgendamento, horaAgendamento) {
  return agendarMensagem(emailUsuario, nomeUsuario, destino, mensagem, dataAgendamento, horaAgendamento);
}

function wListarAgendamentosUsuario(emailUsuario) {
  return listarAgendamentosUsuario(emailUsuario);
}

function wCancelarAgendamento(idAgendamento, emailUsuario) {
  return cancelarAgendamento(idAgendamento, emailUsuario);
}

// ── Wrappers para relatórios de abuso ─────────────────────────
function wCriarReportAbuso(emailReporter, nomeReporter, tipoReport, idMensagem, idUsuarioReportado, motivo) {
  return criarReportAbuso(emailReporter, nomeReporter, tipoReport, idMensagem, idUsuarioReportado, motivo);
}

function wListarReportsPendentes() {
  return listarReportsPendentes();
}

function wListarReportsResolvidos() {
  return listarReportsResolvidos();
}

function wResolverReport(idReport, emailModerador, acao, acaoTomada) {
  return resolverReport(idReport, emailModerador, acao, acaoTomada);
}

function wResolverReportComPunicao(idReport, emailModerador, dadosPunicaoJson) {
  return resolverReportComPunicao(idReport, emailModerador, dadosPunicaoJson);
}

function wVerificarPunicaoAtiva(emailUsuario) {
  Logger.log('=== wVerificarPunicaoAtiva CHAMADO ===');
  Logger.log('Email: ' + emailUsuario);
  Logger.log('Tipo de emailUsuario: ' + typeof emailUsuario);
  
  if (!emailUsuario) {
    Logger.log('ERRO: emailUsuario é null/undefined/vazio');
    return JSON.stringify({ ok:true, punicao:null });
  }
  
  var resultado = verificarPunicaoAtiva(emailUsuario);
  Logger.log('Resultado: ' + resultado);
  return resultado;
}

function wCriarRecursoPunicao(idPunicao, emailUsuario, justificativa) {
  return criarRecursoPunicao(idPunicao, emailUsuario, justificativa);
}

function wObterRecursoUsuario(idPunicao, emailUsuario) {
  return obterRecursoUsuario(idPunicao, emailUsuario);
}

function wListarRecursosPendentes() {
  return listarRecursosPendentes();
}

function wListarRecursosResolvidos() {
  return listarRecursosResolvidos();
}

function wResponderRecurso(idRecurso, emailAdmin, decisao, resposta) {
  return responderRecurso(idRecurso, emailAdmin, decisao, resposta);
}

function wReajustarPunicao(idPunicao, novoTipo, novaQuantidade, novaUnidade, emailAdmin, motivoReajuste) {
  return reajustarPunicao(idPunicao, novoTipo, novaQuantidade, novaUnidade, emailAdmin, motivoReajuste);
}

// ── Wrapper para estatísticas avançadas ───────────────────────
function wObterEstatisticasAvancadas() {
  return obterEstatisticasAvancadas();
}

// ── Wrappers para backup e restore ─────────────────────────────
function wCriarBackupCompleto() {
  return criarBackupCompleto();
}

function wRestaurarBackup(arquivoId, emailUsuario) {
  return restaurarBackup(arquivoId, emailUsuario);
}

function wListarBackupsDisponiveis() {
  return listarBackupsDisponiveis();
}

// ── Wrappers para threads ───────────────────────────────────────
function wCriarThread(idMensagemOriginal, idGrupo, emailCriador, nomeCriador, titulo) {
  return criarThread(idMensagemOriginal, idGrupo, emailCriador, nomeCriador, titulo);
}

function wListarThreadsGrupo(idGrupo) {
  return listarThreadsGrupo(idGrupo);
}

function wObterMensagensThread(idThread) {
  return obterMensagensThread(idThread);
}

function wDiagnosticarSistemaCompleto() {
  return diagnosticarSistemaCompleto();
}

function wEnviarMensagemThread(idThread, mensagem, emailUsuario, nomeUsuario) {
  return enviarMensagemThread(idThread, mensagem, emailUsuario, nomeUsuario);
}

function wListarThreadsPorMensagem(idMensagemOriginal) {
  return listarThreadsPorMensagem(idMensagemOriginal);
}

// ── Wrappers para regras de grupo ─────────────────────────────
function wCriarRegraGrupo(idGrupo, titulo, descricao, emailCriador, nomeCriador) {
  return criarRegraGrupo(idGrupo, titulo, descricao, emailCriador, nomeCriador);
}

function wListarRegrasGrupo(idGrupo) {
  return listarRegrasGrupo(idGrupo);
}

function wRemoverRegraGrupo(idRegra, emailUsuario) {
  return removerRegraGrupo(idRegra, emailUsuario);
}

function wEditarRegraGrupo(idRegra, emailUsuario, novoTitulo, novaDescricao) {
  return editarRegraGrupo(idRegra, emailUsuario, novoTitulo, novaDescricao);
}

// ── Wrapper extra para reply ──────────────────────────────
function wEnviarResposta(nome, texto, idMsgOriginal, email) {
  return salvarRespostaMensagem(nome, texto, idMsgOriginal, email);
}

// ── Reparo manual de estrutura (callable pelo admin) ─────
function wRepararEstrutura() {
  try {
    var reparadas = autoRepararEstrutura();
    // Invalida todos os caches para forçar reload limpo
    try {
      CacheService.getScriptCache().removeAll();
    } catch(e) {
      Logger.log('removeAll falhou em wRepararEstrutura: ' + e.message);
    }
    return JSON.stringify({ ok:true, reparadas:reparadas, msg: reparadas.length > 0 ? 'Abas criadas: '+reparadas.join(', ') : 'Estrutura já estava correta.' });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Wrappers de grupos com membros e aprovação ────────────

function wSolicitarCriacaoGrupo(nome, desc, icone, emailCriador, nomeCriador, membrosJson) {
  return solicitarCriacaoGrupo(nome, desc, icone, emailCriador, nomeCriador, membrosJson);
}

function wListarSolicitacoesGrupo() {
  return listarSolicitacoesGrupo();
}

function wResponderSolicitacaoGrupo(linha, decisao, motivo, solicitante) {
  return responderSolicitacaoGrupo(linha, decisao, motivo, solicitante);
}

function wChecarStatusSolicitacao(email) {
  return checarStatusSolicitacaoGrupo(email);
}

function wListarUsuariosParaMembros() {
  return listarUsuariosParaMembros();
}

function wListarTodosGrupos() {
  return listarTodosGrupos();
}

function wAdicionarMembro(idGrupo, emailMembro, solicitante) {
  // Se solicitante é a senha admin → usar token interno
  var sol = verificarSenhaAdmin(solicitante) ? _getAdminToken() : solicitante;
  return adicionarMembroGrupo(idGrupo, emailMembro, sol);
}

function wRemoverMembro(idGrupo, emailMembro, solicitante) {
  var sol = verificarSenhaAdmin(solicitante) ? _getAdminToken() : solicitante;
  return removerMembroGrupo(idGrupo, emailMembro, sol);
}

function wPromoverAdminGrupo(idGrupo, emailNovoAdmin, solicitante) {
  var sol = verificarSenhaAdmin(solicitante) ? _getAdminToken() : solicitante;
  return promoverAdminGrupo(idGrupo, emailNovoAdmin, sol);
}

function wRevogarAdminGrupo(idGrupo, emailAdmin, solicitante) {
  if (!verificarSenhaAdmin(solicitante))
    return JSON.stringify({ ok:false, erro:'Apenas o administrador do sistema pode revogar admins de grupo.' });
  return revogarAdminGrupo(idGrupo, emailAdmin, _getAdminToken());
}

function wExecutarLimpezaAutomatica() {
  return executarLimpezaAutomatica();
}

function wObterEmailsAdmins() {
  try {
    Logger.log('wObterEmailsAdmins chamado');
    var lista = obterConfiguracao('EmailsAdmins') || '';
    Logger.log('Lista de admins retornada: ' + lista);
    return JSON.stringify({ ok:true, emails:lista });
  } catch(e) {
    Logger.log('Erro em wObterEmailsAdmins: ' + e.message);
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

function wObterEmailsModeradores() {
  try {
    // Primeiro tenta ler da aba Moderacao (nova estrutura)
    var planilha = obterPlanilhaChat();
    var abaModeracao = planilha.getSheetByName(ABA_MODERACAO);
    
    if (abaModeracao) {
      var dados = abaModeracao.getDataRange().getValues();
      var emails = [];
      
      for (var i = 1; i < dados.length; i++) {
        var status = String(dados[i][2] || '').toUpperCase();
        if (status === 'ATIVO') {
          var email = normalizarEmail(dados[i][0]);
          if (email) emails.push(email);
        }
      }
      
      if (emails.length > 0) {
        return JSON.stringify({ ok:true, emails:emails.join(',') });
      }
    }
    
    // Fallback: ler da configuração antiga (aba Config)
    var lista = obterConfiguracao('EmailsModeradores') || '';
    return JSON.stringify({ ok:true, emails:lista });
    
  } catch(e) {
    // Fallback em caso de erro
    try {
      var lista = obterConfiguracao('EmailsModeradores') || '';
      return JSON.stringify({ ok:true, emails:lista });
    } catch(e2) {
      return JSON.stringify({ ok:false, erro:e.message });
    }
  }
}

function wAtualizarEmailsModeradores(emails, solicitante) {
  return atualizarEmailsModeradores(emails, solicitante);
}

function wListarUsuariosParaModeracao() {
  return listarUsuariosParaModeracao();
}

function wAtribuirModerador(email, solicitante, senha) {
  return atribuirModerador(email, solicitante, senha);
}

function wRevogarModerador(email, solicitante, senha) {
  return revogarModerador(email, solicitante, senha);
}

function wAdicionarAdminPorSenha(email) {
  return adicionarAdminPorSenha(email);
}

// ── Mensagens Privadas (DM) ─────────────────────────────────
function wCriarConversaPrivada(email1, email2, nome1, nome2) {
  return criarConversaPrivada(email1, email2, nome1, nome2);
}

function wListarConversasPrivadas(emailUsuario) {
  return listarConversasPrivadas(emailUsuario);
}

function wEnviarMensagemPrivada(emailRemetente, nomeRemetente, emailDestinatario, mensagem, idRespondida) {
  return enviarMensagemPrivada(emailRemetente, nomeRemetente, emailDestinatario, mensagem, idRespondida);
}

function wCarregarMensagensPrivadas(idConversa, aPartirDe) {
  return carregarMensagensPrivadas(idConversa, aPartirDe);
}

function wMarcarLidasPrivadas(idConversa, emailUsuario) {
  return marcarLidasPrivadas(idConversa, emailUsuario);
}

function wApagarMensagemPrivada(idMensagem, emailUsuario) {
  return apagarMensagemPrivada(idMensagem, emailUsuario);
}

// ── Upload de Arquivos ────────────────────────────────────
function wUploadArquivo(base64Data, nomeArquivo, tipoMime, emailUsuario) {
  return uploadArquivo(base64Data, nomeArquivo, tipoMime, emailUsuario);
}

function wObterInfoArquivo(idArquivo) {
  return obterInfoArquivo(idArquivo);
}

function wDeletarArquivo(idArquivo, emailUsuario) {
  return deletarArquivo(idArquivo, emailUsuario);
}

function wListarArquivosUsuario(emailUsuario, limite) {
  return listarArquivosUsuario(emailUsuario, limite);
}

// ── Status de Mensagem ─────────────────────────────────────
function wAtualizarStatusMensagem(idMensagem, novoStatus, emailUsuario) {
  return atualizarStatusMensagem(idMensagem, novoStatus, emailUsuario);
}

function wMarcarComoEntregue(idGrupo, emailUsuario) {
  return marcarComoEntregue(idGrupo, emailUsuario);
}

function wMarcarComoLidaStatus(idGrupo, emailUsuario) {
  return marcarComoLidaStatus(idGrupo, emailUsuario);
}

function wObterNaoLidas(emailUsuario) {
  return obterNaoLidas(emailUsuario);
}

// ── Encaminhamento de Mensagens ─────────────────────────────
function wEncaminharMensagem(idMensagemOriginal, destino, nomeRemetente, emailUsuario, mensagemAdicional) {
  return encaminharMensagem(idMensagemOriginal, destino, nomeRemetente, emailUsuario, mensagemAdicional);
}

function wListarMensagensRecentesParaEncaminhar(emailUsuario, limite) {
  return listarMensagensRecentesParaEncaminhar(emailUsuario, limite);
}

function wListarMembrosGrupo(idGrupo) {
  return listarMembrosGrupo(idGrupo);
}

// ── Enquetes/Polls ───────────────────────────────────────────
function wCriarEnquete(idGrupo, criadorEmail, criadorNome, pergunta, opcoes, duracaoHoras) {
  return criarEnquete(idGrupo, criadorEmail, criadorNome, pergunta, opcoes, duracaoHoras);
}

function wVotarEnquete(idEnquete, opcao, emailVotante, nomeVotante) {
  return votarEnquete(idEnquete, opcao, emailVotante, nomeVotante);
}

function wListarEnquetesGrupo(idGrupo) {
  return listarEnquetesGrupo(idGrupo);
}

function wEncerrarEnquete(idEnquete, emailSolicitante) {
  return encerrarEnquete(idEnquete, emailSolicitante);
}

// ── Sistema de Automação/Bot ───────────────────────────────────
function wCriarAutomacaoBemVindo(idGrupo, mensagem, emailCriador) {
  return criarAutomacaoBemVindo(idGrupo, mensagem, emailCriador);
}

function wCriarAutomacaoModAuto(idGrupo, palavrasBloqueadas, emailCriador) {
  return criarAutomacaoModAuto(idGrupo, palavrasBloqueadas, emailCriador);
}

function wVerificarModeracaoAuto(idGrupo, mensagem, emailUsuario) {
  return verificarModeracaoAuto(idGrupo, mensagem, emailUsuario);
}

function wObterAutomacaoBemVindo(idGrupo) {
  return obterAutomacaoBemVindo(idGrupo);
}

function wListarAutomacoesGrupo(idGrupo) {
  return listarAutomacoesGrupo(idGrupo);
}

function wDesativarAutomacao(idGrupo, tipo) {
  return desativarAutomacao(idGrupo, tipo);
}

// ── Busca Avançada ───────────────────────────────────────────
function wBuscarGlobal(query, emailUsuario, limite) {
  return buscarGlobal(query, emailUsuario, limite);
}

// ── Rate Limiting ───────────────────────────────────────────
function wVerificarRateLimitMensagem(emailUsuario) {
  return JSON.stringify(verificarRateLimitMensagem(emailUsuario));
}

function wVerificarRateLimitUpload(emailUsuario) {
  return JSON.stringify(verificarRateLimitUpload(emailUsuario));
}

function wVerificarRateLimitGrupo(emailUsuario) {
  return JSON.stringify(verificarRateLimitGrupo(emailUsuario));
}

function wObterEstatisticasRateLimit(emailUsuario) {
  return obterEstatisticasRateLimit(emailUsuario);
}

function wResetarRateLimit(emailUsuario, senhaAdmin) {
  return resetarRateLimit(emailUsuario, senhaAdmin);
}

// ── Link Preview ────────────────────────────────────────────
function wObterPreviewLink(url) {
  return obterPreviewLinkComCache(url);
}

function wObterPreviewLinks(urls) {
  return obterPreviewLinks(urls);
}
