// ============================================================
// CONFIGURACAO.gs — Constantes e Configuração Central
// Sistema: Sonne Chat v3.0 — Otimizado para 30+ usuários
// ============================================================

const SISTEMA_NOME    = 'Sonne';
const SISTEMA_VERSAO  = '3.5.1';
const SPREADSHEET_ID  = '###';

// Senha admin movida para PropertiesService por segurança
function getSenhaAdmin() {
  Logger.log('getSenhaAdmin chamado');
  var props = PropertiesService.getScriptProperties();
  var senha = props.getProperty('SENHA_ADMIN');
  Logger.log('Senha do PropertiesService: ' + (senha ? '***' : 'null'));
  if (!senha) {
    // Primeira vez - define senha padrão e avisa para alterar
    senha = '85935164';
    props.setProperty('SENHA_ADMIN', senha);
    Logger.log('⚠️ ATENÇÃO: Senha admin padrão definida. Altere via definirSenhaAdmin()');
  }
  Logger.log('Senha retornada: ' + (senha ? '***' : 'null'));
  return senha;
}

function definirSenhaAdmin(novaSenha) {
  if (!novaSenha || novaSenha.length < 6) {
    throw new Error('Senha deve ter no mínimo 6 caracteres');
  }
  PropertiesService.getScriptProperties().setProperty('SENHA_ADMIN', novaSenha);
  return 'Senha atualizada com sucesso';
}

// ── Limites e tempos ──────────────────────────────────────
const MAX_TAMANHO_MSG        = 2000;
const LIMITE_HISTORICO       = 150;   // mensagens por poll
const MINUTOS_APAGAR_MSG     = 15;
const MINUTOS_EDITAR_MSG     = 15;
const MAX_MENSAGENS_EXPORTAR = 500;
const MAX_LOGS_RETENCAO      = 500;
const LOGS_RECENTES_LIMITE   = 50;
const DIAS_RETENCAO          = 90;    // dias para retenção de mensagens

// ── TTLs de cache (segundos) ──────────────────────────────
const CACHE_TTL_MSGS     = 10;   // carga inicial de mensagens — aumentado para 30+ usuários
const CACHE_TTL_GRUPOS   = 180;  // lista de grupos — aumentado
const CACHE_TTL_USUARIOS = 120;  // lista de usuários — aumentado
const CACHE_TTL_ONLINE   = 60;   // presença — aumentado
const CACHE_TTL_STRUCT   = 21600; // estrutura da planilha (6 h)
const CACHE_TTL_CONFIG   = 600;  // config/bloqueio — aumentado

// ── Limites de cache ───────────────────────────────────────
const FILA_MAX           = 100;  // máximo de mensagens mantidas na fila do cache (aumentado para 30+ usuários)
const _CACHE_MAX_BYTES   = 95000; // 95 KB — margem de segurança abaixo dos 100 KB do GAS

// ── Limites de leitura ────────────────────────────────────
// Quantas linhas ler para trás no delta poll (msgs novas)
// 200 linhas = ~200 msgs — suficiente para grupos ativos
// Se precisar de mais, o frontend fará nova carga completa
const DELTA_MAX_LINHAS = 200;

// ── Nomes das abas ────────────────────────────────────────
const ABA_MENSAGENS   = 'Mensagens';
const ABA_USUARIOS    = 'Usuarios';
const ABA_GRUPOS      = 'Grupos';
const ABA_PEDIDOS     = 'PedidosNome';
const ABA_SOLICIT_GRUPO = 'SolicitacoesGrupo';
const ABA_CONFIG      = 'Config';
const ABA_NOTIF       = 'Notificacoes';
const ABA_LOGS        = 'LogsSistema';
const ABA_CONVERSAS_PRIVADAS = 'ConversasPrivadas';
const ABA_MENSAGENS_PRIVADAS = 'MensagensPrivadas';
const ABA_MODERACAO   = 'Moderacao';
const ABA_ENQUETES    = 'Enquetes';
const ABA_AUTOMACAO   = 'Automacao';
const ABA_BUSCAS      = 'Buscas';
const ABA_COMANDOS    = 'Comandos';
const ABA_AGENDAMENTOS = 'Agendamentos';
const ABA_REPORTS     = 'Reports';
const ABA_THREADS     = 'Threads';
const ABA_MENSAGENS_THREADS = 'MensagensThreads';
const ABA_REGRAS      = 'Regras';
const ABA_PUNICOES    = 'Punicoes';
const ABA_RECURSOS    = 'Apelação';

// ── Configurações de Cache ───────────────────────────────────
const CACHE_PREFIXO = 'sonne_';
const CACHE_TTL_CURTO = 60;      // 1 minuto
const CACHE_TTL_MEDIO = 300;     // 5 minutos
const CACHE_TTL_LONGO = 1800;    // 30 minutos

// ── Configurações de Otimização ───────────────────────────────
const MAX_MENSAGENS_PAGINA = 150; // Mensagens por página no chat / max 150
const MAX_MENSAGENS_DOM = 100;   // Máximo de mensagens renderizadas no DOM (virtual scrolling)

// ── Estrutura das abas ────────────────────────────────────
function obterEstruturaAbas() {
  return {
    Mensagens: {
      ordem: 1,
      headers: ['Data','Hora','Remetente','Destinatario','Mensagem',
                'Leitores','IdMsg','Reacoes','Editada','StatusMsg',
                'IdRespondida','TextoOriginal','Mencoes','Arquivo'],
      larguras: [95,75,130,130,320,160,260,200,80,90,260,320,200,200]
    },
    Usuarios: {
      ordem: 2,
      headers: ['Email','NomeAtual','DataCadastro','UltimoAcesso','Status','Avatar','Bio'],
      larguras: [220,140,150,150,100,100,200]
    },
    Grupos: {
      ordem: 3,
      headers: ['IdGrupo','NomeGrupo','Descricao','Criador','DataCriacao','Membros','Icone','AdminGrupo','StatusGrupo'],
      larguras: [200,180,250,180,160,400,80,200,100]
    },
    PedidosNome: {
      ordem: 4,
      headers: ['NomeAtual','NomeNovo','Status','DataHora','Email'],
      larguras: [130,130,100,160,220]
    },
    SolicitacoesGrupo: {
      ordem: 5,
      headers: ['IdSolicitacao','NomeGrupo','Descricao','Icone','CriadorEmail','CriadorNome','Membros','Status','DataHora','MotivoRecusa'],
      larguras: [220,180,250,80,220,140,400,100,160,250]
    },
    Config: {
      ordem: 6,
      headers: ['Chave','Valor','AtualizadoEm'],
      larguras: [180,320,160]
    },
    Notificacoes: {
      ordem: 7,
      headers: ['ID','Ativa','Mensagem','Duracao','Tipo','Timestamp','DataCriacao','UsuariosFecharam'],
      larguras: [200,80,300,100,100,150,160,250]
    },
    LogsSistema: {
      ordem: 8,
      headers: ['DataHora','Tipo','Usuario','Acao','Detalhes'],
      larguras: [160,100,150,200,300]
    },
    ConversasPrivadas: {
      ordem: 9,
      headers: ['IdConversa','Email1','Nome1','Email2','Nome2','DataCriacao','Status'],
      larguras: [300,220,140,220,140,160,100]
    },
    MensagensPrivadas: {
      ordem: 10,
      headers: ['IdConversa','EmailRemetente','NomeRemetente','Mensagem','Data','Hora','IdMensagem','Timestamp','Status','Reacoes','Editada','TextoOriginal','IdRespondida'],
      larguras: [300,220,140,320,95,75,260,150,100,200,80,320,200]
    },
    Moderacao: {
      ordem: 11,
      headers: ['Email','Nome','StatusModerador','DataAtribuicao','AtribuidoPor'],
      larguras: [220,140,120,160,220]
    },
    Enquetes: {
      ordem: 12,
      headers: ['IdEnquete','IdGrupo','CriadorEmail','CriadorNome','Pergunta','OpcoesJSON','VotosJSON','Status','DataCriacao','DataEncerramento'],
      larguras: [300,200,220,140,400,400,400,100,150,150]
    },
    Automacao: {
      ordem: 13,
      headers: ['IdGrupo','Tipo','ConfigJSON','Status','DataCriacao'],
      larguras: [300,150,400,100,150]
    },
    Buscas: {
      ordem: 14,
      headers: ['IdBusca','UsuarioBusca','TipoBusca','Termo','FiltrosJSON','ResultadosJSON','DataBusca'],
      larguras: [300,220,150,300,400,400,150]
    },
    Comandos: {
      ordem: 15,
      headers: ['IdComando','Grupo','Comando','Parametros','EmailExecutor','NomeExecutor','DataExecucao','Resultado'],
      larguras: [300,200,150,300,220,140,150,200]
    },
    Agendamentos: {
      ordem: 16,
      headers: ['IdAgendamento','EmailCriador','NomeCriador','Destino','Mensagem','DataAgendamento','HoraAgendamento','Status','DataCriacao'],
      larguras: [300,220,140,200,400,150,95,100,150]
    },
    Reports: {
      ordem: 17,
      headers: ['IdReport','EmailReporter','NomeReporter','TipoReport','IdMensagem','IdUsuarioReportado','Motivo','Status','DataReport','DataResolucao','ResolvidoPor','AcaoTomada'],
      larguras: [300,220,140,150,260,220,300,100,150,150,220,400]
    },
    Threads: {
      ordem: 18,
      headers: ['IdThread','IdMensagemOriginal','IdGrupo','CriadorEmail','CriadorNome','Titulo','DataCriacao','Status','NumMensagens'],
      larguras: [300,260,200,220,140,300,150,100,120]
    },
    MensagensThreads: {
      ordem: 20,
      headers: ['IdMensagem','IdThread','RemetenteEmail','RemetenteNome','Mensagem','Data','Hora','IdReferencia','Reacoes','Editada','StatusMsg','TextoOriginal','IdRespondida'],
      larguras: [300,300,220,140,400,100,100,260,200,100,100,400,260]
    },
    Regras: {
      ordem: 19,
      headers: ['IdRegra','IdGrupo','Titulo','Descricao','CriadorEmail','CriadorNome','DataCriacao','Status'],
      larguras: [300,200,200,400,220,140,150,100]
    }
  };
}

function obterListaReacoes()  { return ['👍','👎','❤️','😂','😮','😢','😡','🔥','👏','💔']; }
function obterListaEmojis()   {
  return [
    // Emoticons básicos
    '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍',
    '🥰','😘','😗','😙','😋','😛','😝','😜','🤩','🥳','😎','🤔','🤗','😏','😒',
    '😞','😔','😟','😕','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡',
    '🤬','🤯','😳','😱','😨','😰','😥','😓','🤫','🤥','😶','😐','😑','😬','🙄',
    '😯','😦','😧','😮','😲','🥱','😴','😵','🤐','🥴','🤢','🤮','🤧','😷',
    // Mãos e gestos
    '�','🤚','�️','✋','🖖','👌','�','✌️','�','�','🤘','🤙','�','👉','👆',
    '🖕','👇','☝️','👍','👎','✊','👊','�','🤜','�','�','👐','🤲','🤝','🙏',
    // Corações
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖',
    '💘','💝',
    // Animais
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵',
    // Natureza
    '🌸','💮','🏵️','🌹','🥀','🌺','🌻','🌼','🌷','🌱','🌲','🌳','🌴','🌵','🌾',
    // Comida
    '🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥',
    // Objetos
    '⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼',
    // Símbolos
    '❌','⭕','✅','☑️','✔️','✖️','➕','➖','➗','➰','➿','〽️','✳️','✴️','❇️',
    '‼️','⁉️','❓','❔','❕','❗','〰️','©️','®️','™️','🔥','⭐','✨','🎉','🎊','🎈'
  ];
}
function obterStatusUsuario() { return ['Ativo','Ocupado','Ausente']; }
function obterVersaoCompleta(){ return SISTEMA_NOME + ' v' + SISTEMA_VERSAO; }
function obterInfoSistema()   {
  return { nome: SISTEMA_NOME, versao: SISTEMA_VERSAO, versaoCompleta: obterVersaoCompleta(), spreadsheetId: SPREADSHEET_ID };
}

// ── Chaves de cache ───────────────────────────────────────
function ckMsgs(canal)    { return 'msgs_' + canal + '_v' + SISTEMA_VERSAO; }
function ckGrupos()       { return 'grupos_v' + SISTEMA_VERSAO; }
function ckUsuarios()     { return 'users_v' + SISTEMA_VERSAO; }
function ckOnline(nome)   { return 'onl_' + String(nome).toLowerCase(); }
function ckStruct()       { return 'struct_' + SISTEMA_VERSAO; }
function ckConfig()       { return 'cfg_' + SISTEMA_VERSAO; }
function ckNotif()        { return 'notif_' + SISTEMA_VERSAO; }
function ckConversasPrivadas() { return 'conv_priv_v' + SISTEMA_VERSAO; }
function ckMensagensPrivadas(idConversa) { return 'msgs_priv_' + idConversa + '_v' + SISTEMA_VERSAO; }

// ── Acesso à planilha ─────────────────────────────────────
function obterPlanilhaChat()      {
  Logger.log('obterPlanilhaChat iniciado, SPREADSHEET_ID: ' + SPREADSHEET_ID);
  var planilha = SpreadsheetApp.openById(SPREADSHEET_ID);
  Logger.log('Planilha obtida: ' + (planilha ? planilha.getName() : 'null'));
  return planilha;
}
function obterAbaPorNome(n)       {
  Logger.log('obterAbaPorNome iniciado, buscando aba: ' + n);
  var aba = obterPlanilhaChat().getSheetByName(n);
  Logger.log('Aba obtida: ' + (aba ? aba.getName() : 'null'));
  return aba;
}

function estruturaEstaEmCache() {
  return !!CacheService.getScriptCache().get(ckStruct());
}
function marcarEstruturaOk() {
  CacheService.getScriptCache().put(ckStruct(), '1', CACHE_TTL_STRUCT);
}
function invalidarCacheEstrutura() {
  CacheService.getScriptCache().remove(ckStruct());
}
function limparCacheSistema() {
  try {
    var cache = CacheService.getScriptCache();
    // Tentar limpar chaves conhecidas individualmente
    var prefixos = ['fila_', 'msgs_', 'usuarios_', 'grupos_', 'onl_', 'cfg_', 'struct_', 'notif_', 'conv_priv_', 'msgs_priv_'];
    var removidas = 0;
    
    // Como não podemos listar todas as chaves, vamos limpar usando removeAll se disponível
    // Se não funcionar, o erro será capturado
    cache.removeAll();
    return JSON.stringify({ ok: true });
  } catch(e) {
    // Fallback: limpar chaves específicas conhecidas
    try {
      var cache = CacheService.getScriptCache();
      cache.remove('fila_grupo_geral_v3.0.0');
      cache.remove('msgs_grupo_geral_v3.0.0');
      cache.remove('grupos_v3.0.0');
      cache.remove('users_v3.0.0');
      cache.remove('struct_3.0.0');
      cache.remove('cfg_3.0.0');
      cache.remove('notif_3.0.0');
      return JSON.stringify({ ok: true, aviso: 'Limpeza parcial (removeAll falhou)' });
    } catch(e2) {
      return JSON.stringify({ ok: false, erro: e.message + ' | ' + e2.message });
    }
  }
}
