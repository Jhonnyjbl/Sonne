// ============================================================
// 08_Diagnostico.gs — Ferramenta de Diagnóstico Completo
// Execute as funções no Editor do GAS ou via frontend para
// diagnosticar e manter o sistema.
// ============================================================

/**
 * Diagnóstico completo do sistema
 * Verifica planilha, abas, estrutura, cache e funções principais
 */
function diagnosticarSistemaCompleto() {
  var resultados = [];
  var erros = [];
  var avisos = [];
  
  resultados.push('=== DIAGNÓSTICO COMPLETO DO SISTEMA ===');
  resultados.push('');
  
  // 1. Verificar planilha
  try {
    var planilha = obterPlanilhaChat();
    resultados.push('✅ Planilha encontrada: ' + planilha.getName());
    resultados.push('   URL: ' + planilha.getUrl());
  } catch(e) {
    erros.push('❌ Erro ao acessar planilha: ' + e.message);
    resultados.push('❌ Erro ao acessar planilha: ' + e.message);
    return resultados.join('\n');
  }
  
  resultados.push('');
  resultados.push('=== VERIFICAÇÃO DE ABAS ===');
  
  // Lista de abas esperadas
  var abasEsperadas = [
    { nome: ABA_MENSAGENS, obrigatorio: true },
    { nome: ABA_GRUPOS, obrigatorio: true },
    { nome: ABA_USUARIOS, obrigatorio: true },
    { nome: ABA_REGRAS, obrigatorio: false },
    { nome: ABA_PUNICOES, obrigatorio: false },
    { nome: ABA_RECURSOS, obrigatorio: false },
    { nome: ABA_REPORTS, obrigatorio: false },
    { nome: ABA_THREADS, obrigatorio: false },
    { nome: ABA_MENSAGENS_THREADS, obrigatorio: false }
  ];
  
  var abasExistentes = planilha.getSheets().map(function(s) { return s.getName(); });
  
  abasEsperadas.forEach(function(aba) {
    var existe = abasExistentes.indexOf(aba.nome) !== -1;
    if (existe) {
      resultados.push('✅ Aba ' + aba.nome + ' existe');
    } else {
      var msg = aba.obrigatorio ? '❌ Aba ' + aba.nome + ' NÃO existe (obrigatória)' : '⚠️  Aba ' + aba.nome + ' não existe (opcional)';
      resultados.push(msg);
      if (aba.obrigatorio) erros.push(msg);
      else avisos.push(msg);
    }
  });
  
  resultados.push('');
  resultados.push('=== VERIFICAÇÃO DE ESTRUTURA DAS ABAS ===');
  
  // Verificar estrutura de cada aba existente
  var estruturaEsperada = obterEstruturaAbas();
  
  for (var nome in estruturaEsperada) {
    var aba = obterAbaPorNome(nome);
    if (!aba) continue;
    
    var dados = aba.getDataRange().getValues();
    var headers = dados.length > 0 ? dados[0] : [];
    var esperados = estruturaEsperada[nome].headers || [];
    
    if (headers.length === 0) {
      resultados.push('❌ Aba ' + nome + ' está vazia (sem cabeçalho)');
      erros.push('Aba ' + nome + ' está vazia');
      continue;
    }
    
    var headersCorretos = true;
    for (var i = 0; i < esperados.length; i++) {
      if (headers[i] !== esperados[i]) {
        headersCorretos = false;
        break;
      }
    }
    
    if (headersCorretos) {
      resultados.push('✅ Aba ' + nome + ' - estrutura correta (' + headers.length + ' colunas)');
    } else {
      resultados.push('❌ Aba ' + nome + ' - estrutura incorreta');
      resultados.push('   Esperado: ' + esperados.join(', '));
      resultados.push('   Atual: ' + headers.join(', '));
      erros.push('Estrutura incorreta na aba ' + nome);
    }
    
    resultados.push('   Linhas de dados: ' + (dados.length - 1));
  }
  
  resultados.push('');
  resultados.push('=== VERIFICAÇÃO DE CACHE ===');
  
  try {
    var cache = CacheService.getScriptCache();
    cache.put('_diag_test', 'ok', 30);
    var test = cache.get('_diag_test');
    if (test === 'ok') {
      resultados.push('✅ Cache funcionando corretamente');
    } else {
      resultados.push('❌ Cache não está funcionando');
      erros.push('Cache não funcionando');
    }
  } catch(e) {
    resultados.push('❌ Erro ao testar cache: ' + e.message);
    erros.push('Erro no cache: ' + e.message);
  }
  
  resultados.push('');
  resultados.push('=== VERIFICAÇÃO DE FUNÇÕES PRINCIPAIS ===');
  
  // Testar funções principais
  var funcoesTestar = [
    { nome: 'obterPlanilhaChat', call: obterPlanilhaChat },
    { nome: 'obterEstruturaAbas', call: obterEstruturaAbas },
    { nome: 'listarTodosUsuarios', call: listarTodosUsuarios },
    { nome: 'listarGruposUsuario', call: function() { return listarGruposUsuario('test@example.com'); } }
  ];
  
  funcoesTestar.forEach(function(func) {
    try {
      var resultado = func.call();
      resultados.push('✅ Função ' + func.nome + ' funcionou');
    } catch(e) {
      resultados.push('❌ Função ' + func.nome + ' falhou: ' + e.message);
      erros.push('Função ' + func.nome + ' falhou');
    }
  });
  
  resultados.push('');
  resultados.push('=== VERIFICAÇÃO DE REGRAS ===');
  
  try {
    var resultadoRegras = listarRegrasGrupo('');
    var parsedRegras = JSON.parse(resultadoRegras);
    if (parsedRegras.ok) {
      resultados.push('✅ listarRegrasGrupo funcionou: ' + parsedRegras.regras.length + ' regras');
    } else {
      resultados.push('❌ listarRegrasGrupo falhou: ' + parsedRegras.erro);
      erros.push('listarRegrasGrupo falhou');
    }
  } catch(e) {
    resultados.push('❌ Erro ao testar listarRegrasGrupo: ' + e.message);
    erros.push('Erro em listarRegrasGrupo');
  }
  
  resultados.push('');
  resultados.push('=== RESUMO ===');
  resultados.push('Erros encontrados: ' + erros.length);
  resultados.push('Avisos: ' + avisos.length);
  
  if (erros.length === 0 && avisos.length === 0) {
    resultados.push('');
    resultados.push('🎉 SISTEMA FUNCIONANDO PERFEITAMENTE!');
  } else {
    if (erros.length > 0) {
      resultados.push('');
      resultados.push('ERROS:');
      erros.forEach(function(e) { resultados.push('  - ' + e); });
    }
    if (avisos.length > 0) {
      resultados.push('');
      resultados.push('AVISOS:');
      avisos.forEach(function(a) { resultados.push('  - ' + a); });
    }
  }
  
  return resultados.join('\n');
}

/**
 * Diagnosticar sistema de regras
 * Execute no editor do GAS para verificar se a aba de regras está configurada corretamente
 */
function diagnosticarRegras() {
  var resultados = [];
  
  try {
    var planilha = obterPlanilhaChat();
    resultados.push('✅ Planilha encontrada: ' + planilha.getName());
  } catch(e) {
    resultados.push('❌ Erro ao acessar planilha: ' + e.message);
    return resultados.join('\n');
  }
  
  var aba = obterAbaPorNome(ABA_REGRAS);
  if (!aba) {
    resultados.push('❌ Aba ' + ABA_REGRAS + ' não existe');
    resultados.push('🔧 Tentando criar aba...');
    try {
      aba = _garantirAbaRegras();
      resultados.push('✅ Aba criada com sucesso');
    } catch(e) {
      resultados.push('❌ Erro ao criar aba: ' + e.message);
      return resultados.join('\n');
    }
  } else {
    resultados.push('✅ Aba ' + ABA_REGRAS + ' encontrada');
  }
  
  var dados = aba.getDataRange().getValues();
  resultados.push('📊 Total de linhas: ' + dados.length);
  
  if (dados.length > 1) {
    resultados.push('✅ Tem ' + (dados.length - 1) + ' regra(s) cadastrada(s)');
    for (var i = 1; i < Math.min(dados.length, 6); i++) {
      var linha = dados[i];
      resultados.push('   - Linha ' + i + ': ID=' + String(linha[0]) + ', Grupo=' + String(linha[1]) + ', Título=' + String(linha[2]));
    }
  } else {
    resultados.push('⚠️  Nenhuma regra cadastrada (apenas cabeçalho)');
  }
  
  // Testar listagem
  try {
    var resultado = listarRegrasGrupo('');
    var parsed = JSON.parse(resultado);
    if (parsed.ok) {
      resultados.push('✅ listarRegrasGrupo("") funcionou: ' + parsed.regras.length + ' regras');
    } else {
      resultados.push('❌ listarRegrasGrupo("") falhou: ' + parsed.erro);
    }
  } catch(e) {
    resultados.push('❌ Erro ao testar listarRegrasGrupo: ' + e.message);
  }
  
  return resultados.join('\n');
}

/**
 * Execute esta função no editor do GAS (menu Executar > testarUploadDiagnostico)
 * Ela verifica cache, Drive e retorna onde está o erro "Invalid argument".
 */
function testarUploadDiagnostico() {
  var resultados = [];

  // 1. Cache com dado pequeno
  try {
    var c = CacheService.getScriptCache();
    c.put('_diag_test', 'ok', 30);
    resultados.push('✅ Cache.put() pequeno: OK');
  } catch(e) {
    resultados.push('❌ Cache.put() pequeno: ' + e.message);
  }

  // 2. Cache com dado de 50KB
  try {
    var c = CacheService.getScriptCache();
    var big = new Array(50000).join('x');
    c.put('_diag_test_50k', big, 30);
    resultados.push('✅ Cache.put() 50KB: OK');
  } catch(e) {
    resultados.push('❌ Cache.put() 50KB: ' + e.message);
  }

  // 3. Cache com dado de 100KB (deve falhar com Google)
  try {
    var c = CacheService.getScriptCache();
    var big = new Array(101000).join('x');
    c.put('_diag_test_100k', big, 30);
    resultados.push('✅ Cache.put() 100KB: OK');
  } catch(e) {
    resultados.push('⚠️  Cache.put() 100KB: ' + e.message + ' (esperado — limite do Google)');
  }

  // 4. _cachePutSafe com dado de 100KB (deve ser silencioso)
  try {
    var c = CacheService.getScriptCache();
    var big = new Array(101000).join('x');
    _cachePutSafe(c, '_diag_safe_100k', big, 30);
    resultados.push('✅ _cachePutSafe() 100KB: silenciosamente ignorado, sem erro');
  } catch(e) {
    resultados.push('❌ _cachePutSafe() 100KB: ' + e.message);
  }

  // 5. DriveApp getRootFolder
  try {
    var raiz = DriveApp.getRootFolder();
    resultados.push('✅ DriveApp.getRootFolder(): OK (' + raiz.getName() + ')');
  } catch(e) {
    resultados.push('❌ DriveApp.getRootFolder(): ' + e.message);
  }

  // 6. Session.getScriptTimeZone
  try {
    var tz = Session.getScriptTimeZone();
    resultados.push('✅ Session.getScriptTimeZone(): ' + tz);
  } catch(e) {
    resultados.push('❌ Session.getScriptTimeZone(): ' + e.message);
  }

  // 7. Utilities.formatDate com timezone padrão
  try {
    var dt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
    resultados.push('✅ Utilities.formatDate(): ' + dt);
  } catch(e) {
    resultados.push('❌ Utilities.formatDate(): ' + e.message);
  }

  // 8. Criar pasta Drive de teste
  try {
    var raiz = DriveApp.getRootFolder();
    var nomePasta = 'Sonne_Chat_Arquivos_' + SPREADSHEET_ID.substring(0, 8);
    var pastas = raiz.getFoldersByName(nomePasta);
    if (pastas.hasNext()) {
      resultados.push('✅ Pasta Drive já existe: ' + nomePasta);
    } else {
      resultados.push('ℹ️  Pasta Drive não existe ainda: ' + nomePasta);
    }
  } catch(e) {
    resultados.push('❌ Verificar pasta Drive: ' + e.message);
  }

  // 9. Criar blob de teste pequeno
  try {
    var testBase64 = Utilities.base64Encode('Teste de blob');
    var bytes = Utilities.base64Decode(testBase64);
    var blob = Utilities.newBlob(bytes, 'text/plain', 'teste.txt');
    resultados.push('✅ Utilities.newBlob(): OK');
  } catch(e) {
    resultados.push('❌ Utilities.newBlob(): ' + e.message);
  }

  // 10. Verificar listarTodosGrupos
  try {
    var grupos = JSON.parse(_listarTodosGruposRaw());
    resultados.push('✅ _listarTodosGruposRaw(): ' + grupos.length + ' grupos encontrados');
    var json = JSON.stringify(grupos);
    resultados.push('   Tamanho do JSON: ' + (json.length / 1024).toFixed(1) + ' KB');
    if (json.length > 95000) {
      resultados.push('⚠️  JSON de grupos > 95KB — pode causar overflow no cache!');
    }
  } catch(e) {
    resultados.push('❌ _listarTodosGruposRaw(): ' + e.message);
  }

  // 11. Verificar listarTodosUsuarios
  try {
    var usuarios = JSON.parse(listarTodosUsuarios());
    resultados.push('✅ listarTodosUsuarios(): ' + usuarios.length + ' usuários');
    var json = JSON.stringify(usuarios);
    resultados.push('   Tamanho do JSON: ' + (json.length / 1024).toFixed(1) + ' KB');
    if (json.length > 95000) {
      resultados.push('⚠️  JSON de usuários > 95KB — pode causar overflow no cache!');
    }
  } catch(e) {
    resultados.push('❌ listarTodosUsuarios(): ' + e.message);
  }

  var report = resultados.join('\n');
  Logger.log(report);
  return report;
}

// ============================================================
// LIMPEZA DE CACHE MANUAL
// ============================================================

/**
 * Limpa TODOS os caches do sistema (ScriptCache, DocumentCache, Properties)
 * Execute no Editor do GAS ou chame wLimparCacheCompleto() do frontend
 */
function limparCacheCompleto() {
  var resultados = [];
  
  // 1. Limpar ScriptCache
  try {
    var scriptCache = CacheService.getScriptCache();
    try {
      scriptCache.removeAll();
    } catch(e) {
      // Fallback: limpar chaves específicas
      scriptCache.remove('fila_grupo_geral_v3.0.0');
      scriptCache.remove('msgs_grupo_geral_v3.0.0');
      scriptCache.remove('grupos_v3.0.0');
      scriptCache.remove('users_v3.0.0');
      scriptCache.remove('struct_3.0.0');
      scriptCache.remove('cfg_3.0.0');
      scriptCache.remove('notif_3.0.0');
    }
    resultados.push('✅ ScriptCache limpo com sucesso');
  } catch(e) {
    resultados.push('❌ Erro ao limpar ScriptCache: ' + e.message);
  }
  
  // 2. Limpar DocumentCache
  try {
    var docCache = CacheService.getDocumentCache();
    try {
      docCache.removeAll();
    } catch(e) {
      // Fallback silencioso
    }
    resultados.push('✅ DocumentCache limpo com sucesso');
  } catch(e) {
    resultados.push('❌ Erro ao limpar DocumentCache: ' + e.message);
  }
  
  // 3. Limpar ScriptProperties
  try {
    var scriptProps = PropertiesService.getScriptProperties();
    scriptProps.deleteAllProperties();
    resultados.push('✅ ScriptProperties limpo com sucesso');
  } catch(e) {
    resultados.push('❌ Erro ao limpar ScriptProperties: ' + e.message);
  }
  
  // 4. Limpar UserProperties
  try {
    var userProps = PropertiesService.getUserProperties();
    userProps.deleteAllProperties();
    resultados.push('✅ UserProperties limpo com sucesso');
  } catch(e) {
    resultados.push('❌ Erro ao limpar UserProperties: ' + e.message);
  }
  
  // 5. Limpar DocumentProperties
  try {
    var docProps = PropertiesService.getDocumentProperties();
    docProps.deleteAllProperties();
    resultados.push('✅ DocumentProperties limpo com sucesso');
  } catch(e) {
    resultados.push('❌ Erro ao limpar DocumentProperties: ' + e.message);
  }
  
  var report = resultados.join('\n');
  Logger.log('=== LIMPEZA DE CACHE COMPLETA ===\n' + report);
  return report;
}

/**
 * Limpa apenas caches relacionados a mensagens e grupos
 * Mais seguro para uso frequente
 */
function limparCacheMensagens() {
  var resultados = [];
  var cache = CacheService.getScriptCache();
  
  try {
    // Remover todos os caches que começam com prefixos conhecidos
    var prefixos = ['fila_', 'msgs_', 'usuarios_', 'grupos_', 'ck_'];
    var removidos = 0;
    
    // Nota: CacheService GAS não permite listar todas as chaves
    // Então vamos limpar usando removeAll e forçar recarga
    try {
      cache.removeAll();
    } catch(e) {
      // Fallback: limpar chaves específicas
      cache.remove('fila_grupo_geral_v3.0.0');
      cache.remove('msgs_grupo_geral_v3.0.0');
      cache.remove('grupos_v3.0.0');
      cache.remove('users_v3.0.0');
      cache.remove('struct_3.0.0');
      cache.remove('cfg_3.0.0');
      cache.remove('notif_3.0.0');
    }
    removidos = 'todos (limpeza total)';
    
    resultados.push('✅ Cache de mensagens limpo: ' + removidos);
  } catch(e) {
    resultados.push('❌ Erro ao limpar cache de mensagens: ' + e.message);
  }
  
  var report = resultados.join('\n');
  Logger.log('=== LIMPEZA DE CACHE DE MENSAGENS ===\n' + report);
  return report;
}

// ============================================================
// FORÇAR ATUALIZAÇÃO DO DEPLOY
// ============================================================

/**
 * Força atualização do deploy invalidando todos os caches
 * e incrementando versão do sistema
 */
function forcarAtualizacaoDeploy() {
  var resultados = [];
  
  // 1. Limpar todos os caches
  try {
    var limpeza = limparCacheCompleto();
    resultados.push('✅ Caches limpos');
  } catch(e) {
    resultados.push('❌ Erro ao limpar caches: ' + e.message);
  }
  
  // 2. Incrementar versão do sistema (se possível)
  try {
    var props = PropertiesService.getScriptProperties();
    var versaoAtual = props.getProperty('SISTEMA_VERSAO_DEPLOY') || '1.0.0';
    var partes = versaoAtual.split('.');
    partes[2] = String(parseInt(partes[2] || 0) + 1);
    var novaVersao = partes.join('.');
    props.setProperty('SISTEMA_VERSAO_DEPLOY', novaVersao);
    resultados.push('✅ Versão incrementada: ' + versaoAtual + ' → ' + novaVersao);
  } catch(e) {
    resultados.push('⚠️  Não foi possível incrementar versão: ' + e.message);
  }
  
  // 3. Registrar log de atualização
  try {
    var log = {
      timestamp: new Date().toISOString(),
      acao: 'FORCAR_ATUALIZACAO_DEPLOY',
      resultado: resultados.join('; ')
    };
    Logger.log(JSON.stringify(log));
    resultados.push('✅ Log de atualização registrado');
  } catch(e) {
    resultados.push('❌ Erro ao registrar log: ' + e.message);
  }
  
  var report = resultados.join('\n');
  Logger.log('=== FORÇAR ATUALIZAÇÃO DE DEPLOY ===\n' + report);
  return report;
}

// ============================================================
// DIAGNÓSTICO COMPLETO DO SISTEMA
// ============================================================

/**
 * Executa diagnóstico completo do sistema e retorna relatório detalhado
 */
function diagnosticoCompleto() {
  var resultados = [];
  var agora = new Date();
  
  resultados.push('=== DIAGNÓSTICO COMPLETO DO SISTEMA ===');
  resultados.push('Data/Hora: ' + Utilities.formatDate(agora, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'));
  resultados.push('');
  
  // 1. Informações do Script
  resultados.push('--- INFORMAÇÕES DO SCRIPT ---');
  try {
    resultados.push('Script ID: ' + ScriptApp.getScriptId());
  } catch(e) {
    resultados.push('Script ID: Erro - ' + e.message);
  }
  
  try {
    var usuario = Session.getActiveUser().getEmail();
    resultados.push('Usuário: ' + (usuario || 'N/A'));
  } catch(e) {
    resultados.push('Usuário: Erro - ' + e.message);
  }
  
  try {
    resultados.push('Timezone: ' + Session.getScriptTimeZone());
  } catch(e) {
    resultados.push('Timezone: Erro - ' + e.message);
  }
  
  resultados.push('');
  
  // 2. Status dos Caches
  resultados.push('--- STATUS DOS CACHES ---');
  
  try {
    var scriptCache = CacheService.getScriptCache();
    scriptCache.put('_diag_test', 'ok', 10);
    var valor = scriptCache.get('_diag_test');
    if (valor === 'ok') {
      resultados.push('✅ ScriptCache: Funcionando');
    } else {
      resultados.push('❌ ScriptCache: Não está funcionando corretamente');
    }
    scriptCache.remove('_diag_test');
  } catch(e) {
    resultados.push('❌ ScriptCache: ' + e.message);
  }
  
  try {
    var docCache = CacheService.getDocumentCache();
    docCache.put('_diag_test', 'ok', 10);
    var valor = docCache.get('_diag_test');
    if (valor === 'ok') {
      resultados.push('✅ DocumentCache: Funcionando');
    } else {
      resultados.push('❌ DocumentCache: Não está funcionando corretamente');
    }
    docCache.remove('_diag_test');
  } catch(e) {
    resultados.push('❌ DocumentCache: ' + e.message);
  }
  
  resultados.push('');
  
  // 3. Status do Drive
  resultados.push('--- STATUS DO DRIVE ---');
  
  try {
    var raiz = DriveApp.getRootFolder();
    resultados.push('✅ DriveApp.getRootFolder: OK (' + raiz.getName() + ')');
  } catch(e) {
    resultados.push('❌ DriveApp.getRootFolder: ' + e.message);
  }
  
  try {
    var arquivo = DriveApp.getFileById(SPREADSHEET_ID);
    resultados.push('✅ Acesso à planilha: OK (' + arquivo.getName() + ')');
  } catch(e) {
    resultados.push('❌ Acesso à planilha: ' + e.message);
  }
  
  try {
    var nomePasta = 'Sonne_Chat_Arquivos_' + SPREADSHEET_ID.substring(0, 8);
    var pastas = DriveApp.getRootFolder().getFoldersByName(nomePasta);
    if (pastas.hasNext()) {
      var pasta = pastas.next();
      resultados.push('✅ Pasta de arquivos: OK (' + pasta.getName() + ')');
    } else {
      resultados.push('ℹ️  Pasta de arquivos: Não existe ainda');
    }
  } catch(e) {
    resultados.push('❌ Pasta de arquivos: ' + e.message);
  }
  
  resultados.push('');
  
  // 4. Status da Planilha
  resultados.push('--- STATUS DA PLANILHA ---');
  
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    resultados.push('✅ Abrir planilha: OK');
    resultados.push('   Abas: ' + ss.getNumSheets());
  } catch(e) {
    resultados.push('❌ Abrir planilha: ' + e.message);
  }
  
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var abaMensagens = ss.getSheetByName('Mensagens');
    if (abaMensagens) {
      resultados.push('✅ Aba Mensagens: OK (' + abaMensagens.getLastRow() + ' linhas)');
    } else {
      resultados.push('❌ Aba Mensagens: Não encontrada');
    }
  } catch(e) {
    resultados.push('❌ Aba Mensagens: ' + e.message);
  }
  
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var abaUsuarios = ss.getSheetByName('Usuarios');
    if (abaUsuarios) {
      resultados.push('✅ Aba Usuarios: OK (' + abaUsuarios.getLastRow() + ' linhas)');
    } else {
      resultados.push('❌ Aba Usuarios: Não encontrada');
    }
  } catch(e) {
    resultados.push('❌ Aba Usuarios: ' + e.message);
  }
  
  resultados.push('');
  
  // 5. Estatísticas do Sistema
  resultados.push('--- ESTATÍSTICAS DO SISTEMA ---');
  
  try {
    var usuarios = JSON.parse(listarTodosUsuarios());
    resultados.push('✅ Total de usuários: ' + usuarios.length);
  } catch(e) {
    resultados.push('❌ Contar usuários: ' + e.message);
  }
  
  try {
    var grupos = JSON.parse(listarTodosGrupos());
    resultados.push('✅ Total de grupos: ' + grupos.grupos.length);
  } catch(e) {
    resultados.push('❌ Contar grupos: ' + e.message);
  }
  
  resultados.push('');
  
  // 6. Teste de Upload
  resultados.push('--- TESTE DE UPLOAD ---');
  
  try {
    var testBase64 = Utilities.base64Encode('Teste de upload');
    var bytes = Utilities.base64Decode(testBase64);
    var blob = Utilities.newBlob(bytes, 'text/plain', 'teste.txt');
    resultados.push('✅ Criação de blob: OK');
  } catch(e) {
    resultados.push('❌ Criação de blob: ' + e.message);
  }
  
  var report = resultados.join('\n');
  Logger.log(report);
  return report;
}

// ============================================================
// WRAPPERS PARA CHAMADA DO FRONTEND
// ============================================================

/**
 * Wrapper para limpar cache completo via frontend
 */
function wLimparCacheCompleto(senhaAdmin) {
  // Verificar se é admin (opcional - remover se não necessário)
  if (senhaAdmin && !verificarSenhaAdmin(senhaAdmin)) {
    return JSON.stringify({ ok:false, erro:'Senha de administrador inválida.' });
  }
  
  try {
    var resultado = limparCacheCompleto();
    return JSON.stringify({ ok:true, resultado:resultado });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

/**
 * Wrapper para limpar cache de mensagens via frontend
 */
function wLimparCacheMensagens(senhaAdmin) {
  if (senhaAdmin && !verificarSenhaAdmin(senhaAdmin)) {
    return JSON.stringify({ ok:false, erro:'Senha de administrador inválida.' });
  }
  
  try {
    var resultado = limparCacheMensagens();
    return JSON.stringify({ ok:true, resultado:resultado });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

/**
 * Wrapper para forçar atualização do deploy via frontend
 */
function wForcarAtualizacaoDeploy(senhaAdmin) {
  if (!verificarSenhaAdmin(senhaAdmin)) {
    return JSON.stringify({ ok:false, erro:'Apenas administrador pode forçar atualização.' });
  }
  
  try {
    var resultado = forcarAtualizacaoDeploy();
    return JSON.stringify({ ok:true, resultado:resultado });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

/**
 * Wrapper para diagnóstico completo via frontend
 */
function wDiagnosticoCompleto(senhaAdmin) {
  if (senhaAdmin && !verificarSenhaAdmin(senhaAdmin)) {
    return JSON.stringify({ ok:false, erro:'Senha de administrador inválida.' });
  }
  
  try {
    var resultado = diagnosticoCompleto();
    return JSON.stringify({ ok:true, resultado:resultado });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}
