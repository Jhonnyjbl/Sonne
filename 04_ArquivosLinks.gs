// ============================================================
// ArquivosLinks.gs — Sistema de Arquivos e Preview de Links (Consolidado)
// Consolidado de: Arquivos.gs + LinkPreview.gs
// ============================================================

// ── ARQUIVOS (Arquivos.gs) ───────────────────────────────────

// ── Limites de upload ───────────────────────────────────────
const MAX_TAMANHO_ARQUIVO = 10 * 1024 * 1024; // 10MB
const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

// ── Upload de arquivo ───────────────────────────────────────
function uploadArquivo(base64Data, nomeArquivo, tipoMime, emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  
  // Validar parâmetros de entrada para evitar "Invalid argument" do GAS
  if (!base64Data || typeof base64Data !== 'string' || base64Data.length === 0) {
    return JSON.stringify({ ok:false, erro:'Dados do arquivo inválidos ou vazios.' });
  }
  if (!nomeArquivo || typeof nomeArquivo !== 'string') {
    nomeArquivo = 'arquivo_' + Date.now();
  }
  // Fallback MIME seguro se vier vazio
  if (!tipoMime || typeof tipoMime !== 'string' || tipoMime.trim() === '') {
    tipoMime = 'application/octet-stream';
  }

  try {
    // Validar tamanho
    var tamanho = base64Data.length * 0.75; // Aproximação
    if (tamanho > MAX_TAMANHO_ARQUIVO) {
      return JSON.stringify({ ok:false, erro:'Arquivo muito grande. Máximo: 10MB.' });
    }
    
    // Validar tipo (aceitar application/octet-stream como fallback)
    if (tipoMime !== 'application/octet-stream' && TIPOS_PERMITIDOS.indexOf(tipoMime) === -1) {
      return JSON.stringify({ ok:false, erro:'Tipo de arquivo não permitido: ' + tipoMime });
    }
    
    // Converter base64 para blob — proteger contra base64 malformado
    var bytes;
    try {
      bytes = Utilities.base64Decode(base64Data);
    } catch(decErr) {
      return JSON.stringify({ ok:false, erro:'Erro ao decodificar arquivo: ' + decErr.message });
    }
    if (!bytes || bytes.length === 0) {
      return JSON.stringify({ ok:false, erro:'Arquivo vazio após decodificação.' });
    }
    var blob = Utilities.newBlob(bytes, tipoMime, nomeArquivo);
    
    // Criar pasta do sistema se não existir (ignorar pastas na lixeira)
    var pastaRaiz = DriveApp.getRootFolder();
    var nomePasta = 'Sonne_Chat_Arquivos_' + SPREADSHEET_ID.substring(0, 8);
    var pastaSistema;
    
    var pastas = pastaRaiz.getFoldersByName(nomePasta);
    while (pastas.hasNext()) {
      var f = pastas.next();
      if (!f.isTrashed()) {
        pastaSistema = f;
        break;
      }
    }
    if (!pastaSistema) {
      pastaSistema = pastaRaiz.createFolder(nomePasta);
    }
    
    // Timezone seguro
    var tz = 'America/Sao_Paulo';
    try {
      var scriptTz = Session.getScriptTimeZone();
      if (scriptTz) tz = scriptTz;
    } catch(x){}
    
    // Criar subpasta por data (ignorar subpastas na lixeira)
    var dataPasta = Utilities.formatDate(new Date(), tz, 'yyyy-MM');
    var pastaMes;
    var pastasMes = pastaSistema.getFoldersByName(dataPasta);
    while (pastasMes.hasNext()) {
      var f = pastasMes.next();
      if (!f.isTrashed()) {
        pastaMes = f;
        break;
      }
    }
    if (!pastaMes) {
      pastaMes = pastaSistema.createFolder(dataPasta);
    }
    
    // Salvar arquivo
    var arquivo = pastaMes.createFile(blob);
    // setSharing pode falhar se o escopo drive não estiver configurado — falha silenciosa
    try {
      arquivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch(shareErr) {
      try {
        arquivo.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
      } catch(domainErr) {
        Logger.log('Aviso: não foi possível definir compartilhamento: ' + domainErr.message);
      }
    }
    
    var info = {
      id: arquivo.getId(),
      nome: arquivo.getName(),
      url: arquivo.getUrl(),
      urlDownload: arquivo.getDownloadUrl(),
      tipoMime: arquivo.getMimeType(),
      tamanho: arquivo.getSize(),
      thumbnailUrl: ''
    };
    
    // Gerar thumbnail para imagens
    if (tipoMime.indexOf('image') === 0) {
      try {
        var thumbnail = arquivo.getThumbnail();
        info.thumbnailUrl = 'data:' + tipoMime + ';base64,' + Utilities.base64Encode(thumbnail.getBytes());
      } catch(e) {
        // Thumbnail não disponível
      }
    }
    
    // Registrar no log
    registrarLogSistema('ARQUIVO', em, 'Arquivo enviado', nomeArquivo + ' (' + (tamanho/1024).toFixed(1) + 'KB)');
    
    return JSON.stringify({ ok:true, arquivo:info });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Obter informações de arquivo ────────────────────────────
function obterInfoArquivo(idArquivo) {
  try {
    var arquivo = DriveApp.getFileById(idArquivo);
    return JSON.stringify({
      ok:true,
      id: arquivo.getId(),
      nome: arquivo.getName(),
      url: arquivo.getUrl(),
      urlDownload: arquivo.getDownloadUrl(),
      tipoMime: arquivo.getMimeType(),
      tamanho: arquivo.getSize()
    });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:'Arquivo não encontrado.' });
  }
}

// ── Deletar arquivo ───────────────────────────────────────
function deletarArquivo(idArquivo, emailUsuario) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  
  try {
    var arquivo = DriveApp.getFileById(idArquivo);
    arquivo.setTrashed(true);
    registrarLogSistema('ARQUIVO', em, 'Arquivo deletado', arquivo.getName());
    return JSON.stringify({ ok:true });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Listar arquivos do usuário ─────────────────────────────
function listarArquivosUsuario(emailUsuario, limite) {
  var em = normalizarEmail(emailUsuario);
  if (!em) return JSON.stringify({ ok:false, erro:'Email inválido.' });
  
  try {
    var pastaRaiz = DriveApp.getRootFolder();
    var nomePasta = 'Sonne_Chat_Arquivos_' + SPREADSHEET_ID.substring(0, 8);
    var pastaSistema;
    var pastas = pastaRaiz.getFoldersByName(nomePasta);
    while (pastas.hasNext()) {
      var f = pastas.next();
      if (!f.isTrashed()) {
        pastaSistema = f;
        break;
      }
    }
    
    if (!pastaSistema) {
      return JSON.stringify({ ok:true, arquivos:[] });
    }
    
    var arquivos = [];
    var max = limite || 50;
    var count = 0;
    
    // Buscar em todas as subpastas
    var subpastas = pastaSistema.getFolders();
    while (subpastas.hasNext() && count < max) {
      var subpasta = subpastas.next();
      if (subpasta.isTrashed()) continue;
      var files = subpasta.getFiles();
      while (files.hasNext() && count < max) {
        var arquivo = files.next();
        if (arquivo.isTrashed()) continue;
        arquivos.push({
          id: arquivo.getId(),
          nome: arquivo.getName(),
          url: arquivo.getUrl(),
          tipoMime: arquivo.getMimeType(),
          tamanho: arquivo.getSize(),
          dataCriacao: arquivo.getDateCreated().toISOString()
        });
        count++;
      }
    }
    
    return JSON.stringify({ ok:true, arquivos:arquivos });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Limpar arquivos antigos (manutenção) ───────────────────
function limparArquivosAntigos(dias) {
  var diasLimite = dias || 30;
  var limiteData = new Date();
  limiteData.setDate(limiteData.getDate() - diasLimite);
  
  try {
    var pastaRaiz = DriveApp.getRootFolder();
    var nomePasta = 'Sonne_Chat_Arquivos_' + SPREADSHEET_ID.substring(0, 8);
    var pastaSistema;
    var pastas = pastaRaiz.getFoldersByName(nomePasta);
    while (pastas.hasNext()) {
      var f = pastas.next();
      if (!f.isTrashed()) {
        pastaSistema = f;
        break;
      }
    }
    
    if (!pastaSistema) {
      return 0;
    }
    
    var deletados = 0;
    
    // Buscar em todas as subpastas
    var subpastas = pastaSistema.getFolders();
    while (subpastas.hasNext()) {
      var subpasta = subpastas.next();
      if (subpasta.isTrashed()) continue;
      var files = subpasta.getFiles();
      while (files.hasNext()) {
        var arquivo = files.next();
        if (arquivo.isTrashed()) continue;
        if (arquivo.getDateCreated() < limiteData) {
          arquivo.setTrashed(true);
          deletados++;
        }
      }
    }
    
    registrarLogSistema('ARQUIVO', 'Sistema', 'Limpeza automática', deletados + ' arquivos deletados');
    return deletados;
  } catch(e) {
    Logger.log('Erro ao limpar arquivos antigos: ' + e.message);
    return 0;
  }
}

// ── LINK PREVIEW (LinkPreview.gs) ───────────────────────────

// ── Obter preview de link ────────────────────────────────────
function obterPreviewLink(url) {
  if (!url) return JSON.stringify({ ok:false, erro:'URL vazia.' });
  
  // Validar URL
  var urlRegex = /^(https?:\/\/)/i;
  if (!urlRegex.test(url)) {
    return JSON.stringify({ ok:false, erro:'URL inválida. Deve começar com http:// ou https://' });
  }
  
  try {
    // Fazer fetch da página
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (response.getResponseCode() !== 200) {
      return JSON.stringify({ ok:false, erro:'Não foi possível acessar a URL.' });
    }
    
    var html = response.getContentText();
    
    // Extrair metadados
    var titulo = _extrairMeta(html, 'title') || _extrairMeta(html, 'og:title') || url;
    var descricao = _extrairMeta(html, 'description') || _extrairMeta(html, 'og:description') || '';
    var imagem = _extrairMeta(html, 'og:image') || _extrairMeta(html, 'twitter:image') || '';
    var favicon = _extrairFavicon(html, url);
    
    // Limitar tamanho
    titulo = titulo.length > 100 ? titulo.substring(0, 100) + '...' : titulo;
    descricao = descricao.length > 200 ? descricao.substring(0, 200) + '...' : descricao;
    
    return JSON.stringify({
      ok:true,
      url: url,
      titulo: titulo,
      descricao: descricao,
      imagem: imagem,
      favicon: favicon
    });
  } catch(e) {
    return JSON.stringify({ ok:false, erro:e.message });
  }
}

// ── Extrair meta tag do HTML ───────────────────────────────
function _extrairMeta(html, nome) {
  try {
    var regex;
    if (nome === 'title') {
      regex = /<title>([^<]+)<\/title>/i;
    } else if (nome.startsWith('og:')) {
      regex = new RegExp('<meta[^>]+property=["\']' + nome + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
    } else if (nome.startsWith('twitter:')) {
      regex = new RegExp('<meta[^>]+name=["\']' + nome + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
    } else {
      regex = new RegExp('<meta[^>]+name=["\']' + nome + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
    }
    
    var match = html.match(regex);
    return match ? match[1].trim() : null;
  } catch(e) {
    return null;
  }
}

// ── Extrair favicon ─────────────────────────────────────────
function _extrairFavicon(html, baseUrl) {
  try {
    var regex = /<link[^>]+rel=["\'](?:shortcut )?icon["\'][^>]+href=["\']([^"\']+)["\']/i;
    var match = html.match(regex);
    
    if (match) {
      var faviconUrl = match[1];
      // Converter URL relativa para absoluta
      if (!faviconUrl.startsWith('http')) {
        var urlObj = new URL(baseUrl);
        if (faviconUrl.startsWith('//')) {
          faviconUrl = urlObj.protocol + faviconUrl;
        } else if (faviconUrl.startsWith('/')) {
          faviconUrl = urlObj.origin + faviconUrl;
        } else {
          faviconUrl = urlObj.origin + '/' + faviconUrl;
        }
      }
      return faviconUrl;
    }
    
    // Fallback para favicon padrão
    var urlObj = new URL(baseUrl);
    return urlObj.origin + '/favicon.ico';
  } catch(e) {
    return '';
  }
}

// ── Extrair todos os links de uma mensagem ────────────────────
function extrairLinksMensagem(mensagem) {
  return extrairLinks(mensagem);
}

// ── Obter preview de múltiplos links (batch) ─────────────────
function obterPreviewLinks(urls) {
  if (!urls || !Array.isArray(urls)) return JSON.stringify({ ok:false, erro:'Parâmetro inválido.' });
  
  var previews = [];
  
  for (var i = 0; i < urls.length; i++) {
    try {
      var preview = JSON.parse(obterPreviewLink(urls[i]));
      previews.push(preview);
    } catch(e) {
      previews.push({ ok:false, erro:e.message });
    }
  }
  
  return JSON.stringify({ ok:true, previews:previews });
}

// ── Cache de previews para evitar requisições repetidas ───────
function obterPreviewLinkComCache(url) {
  var cache = CacheService.getScriptCache();
  var ck = 'link_preview_' + Utilities.base64Encode(url);
  var cached = cache.get(ck);
  
  if (cached) {
    return cached;
  }
  
  var preview = obterPreviewLink(url);
  
  // Cache por 1 hora
  cache.put(ck, preview, 3600);
  
  return preview;
}
