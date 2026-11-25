/* =========================================
   CAMADA DE INTEGRAÇÃO COM A API (RENDER / FASTAPI)
========================================= */

const API_BASE_URL = "https://emap-cco-painel.onrender.com/api/v1";

async function fetchComTimeout(url, opcoes = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resposta = await fetch(url, { ...opcoes, signal: controller.signal });
    return resposta;
  } finally {
    clearTimeout(timer);
  }
}

const STORAGE_KEY_CONFIG_OPERACIONAL = "cco_configuracoes_operacionais";
const CONFIG_OPERACIONAL_PADRAO = {
  limiteSobrepesoKg: 48500,
  limiteRetencaoPrcMin: 120,
  intervaloPollingSeg: 30
};

function carregarConfigOperacionalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CONFIG_OPERACIONAL);
    if (!raw) return { ...CONFIG_OPERACIONAL_PADRAO };
    const parsed = JSON.parse(raw);
    return {
      limiteSobrepesoKg: Number(parsed?.limiteSobrepesoKg) > 0 ? Number(parsed.limiteSobrepesoKg) : CONFIG_OPERACIONAL_PADRAO.limiteSobrepesoKg,
      limiteRetencaoPrcMin: Number(parsed?.limiteRetencaoPrcMin) > 0 ? Number(parsed.limiteRetencaoPrcMin) : CONFIG_OPERACIONAL_PADRAO.limiteRetencaoPrcMin,
      intervaloPollingSeg: Number(parsed?.intervaloPollingSeg) >= 5 ? Number(parsed.intervaloPollingSeg) : CONFIG_OPERACIONAL_PADRAO.intervaloPollingSeg
    };
  } catch (e) {
    return { ...CONFIG_OPERACIONAL_PADRAO };
  }
}

function salvarConfigOperacionalStorage(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY_CONFIG_OPERACIONAL, JSON.stringify(cfg));
  } catch (e) {
    console.warn("Não foi possível salvar configurações operacionais:", e);
  }
}

let configOperacionalCCO = carregarConfigOperacionalStorage();
let INTERVALO_ATUALIZACAO_MS = (configOperacionalCCO.intervaloPollingSeg || 30) * 1000;
let pollingTimeoutId = null;
let sincronizacaoEmAndamento = false;

let apiConectada = false;
let etapasCarregadasPorEndpoint = false;
let alertasCarregadosPorEndpoint = false;

let cacheTodosVeiculosAPI = null;
let veiculosAtivosAPI = null;
let ultimoResumoAPI = null;
let ultimosBercosAPI = [];
let ultimasEtapasAPI = [];
let alertasAtivosAPI = [];
let ultimosAlertasBrutos = [];
var contextoInspecaoCard = null;

const STORAGE_KEY_ALERTAS_RESOLVIDOS = "cco_alertas_resolvidos_v1";
const STORAGE_KEY_ALERTAS_RESOLVIDOS_META = "cco_alertas_resolvidos_meta_v1";
const STORAGE_KEY_ALERTAS_EDITADOS = "cco_alertas_editados_v1";
const alertasResolvidosLocal = carregarAlertasResolvidosLocal();
let alertasResolvidosMetaLocal = carregarAlertasResolvidosMetaLocal();
let alertasEditadosLocal = carregarAlertasEditadosLocal();
const mapaAlertasRenderizados = new Map();
let alertaPendenteResolucao = null;

function carregarAlertasEditadosLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ALERTAS_EDITADOS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function salvarAlertasEditadosLocal() {
  try {
    localStorage.setItem(
      STORAGE_KEY_ALERTAS_EDITADOS,
      JSON.stringify(alertasEditadosLocal)
    );
  } catch (e) {
    console.warn("Não foi possível salvar alertas editados no localStorage:", e);
  }
}

function carregarAlertasResolvidosLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ALERTAS_RESOLVIDOS);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch (e) {
    return new Set();
  }
}

function salvarAlertasResolvidosLocal() {
  try {
    localStorage.setItem(
      STORAGE_KEY_ALERTAS_RESOLVIDOS,
      JSON.stringify(Array.from(alertasResolvidosLocal))
    );
  } catch (e) {
    console.warn("Não foi possível salvar alertas resolvidos no localStorage:", e);
  }
}

function carregarAlertasResolvidosMetaLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ALERTAS_RESOLVIDOS_META);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function salvarAlertasResolvidosMetaLocal() {
  try {
    localStorage.setItem(
      STORAGE_KEY_ALERTAS_RESOLVIDOS_META,
      JSON.stringify(alertasResolvidosMetaLocal)
    );
  } catch (e) {
    console.warn("Não foi possível salvar metadados de alertas resolvidos no localStorage:", e);
  }
}

function obterChaveUnicaAlerta(alerta) {
  if (typeof alerta === "string") {
    return `STR::${normalizarTexto(alerta)}`;
  }
  if (!alerta || typeof alerta !== "object") {
    return `RAW::${String(alerta ?? "")}`;
  }
  const placa = normalizarTexto(alerta.placa ?? alerta.plate ?? "");
  const tipoRaw = String(alerta.tipo_anomalia ?? alerta.tipo_alerta ?? "").toUpperCase();
  const excessoKg = Number(alerta.excesso_peso_kg ?? alerta.excesso_peso ?? 0);
  let tipoChave = normalizarTexto(tipoRaw);
  if (tipoRaw.includes("SOBREPESO") || excessoKg > 0) {
    tipoChave = "SOBREPESO";
  } else if (tipoRaw.includes("PRC") || tipoRaw.includes("RETENCAO")) {
    tipoChave = "RETENCAO_PRC";
  }
  return `${tipoChave || "ALERTA"}::${placa || "SEM_PLACA"}`;
}

function filtrarAlertasNaoResolvidos(listaAlertas) {
  const lista = Array.isArray(listaAlertas) ? listaAlertas : [];
  return lista.filter(alerta => !alertasResolvidosLocal.has(obterChaveUnicaAlerta(alerta)));
}

function atualizarBotaoRestaurarAlertas() {
  const btn = document.getElementById("btn-restaurar-alertas");
  if (!btn) return;
  const qtd = alertasResolvidosLocal.size;
  if (qtd > 0) {
    btn.hidden = false;
    btn.textContent =
      idiomaAtual === "en-US"
        ? `Restore resolved (${qtd})`
        : `Restaurar resolvidos (${qtd})`;
  } else {
    btn.hidden = true;
  }
}

/* =========================================
   INTERNACIONALIZAÇÃO (I18N · PT-BR / EN-US)
========================================= */

const STORAGE_KEY_IDIOMA = "cco_language";

function obterIdiomaSalvo() {
  try {
    const salvo = localStorage.getItem(STORAGE_KEY_IDIOMA);
    return salvo === "en-US" ? "en-US" : "pt-BR";
  } catch (e) {
    return "pt-BR";
  }
}

let idiomaAtual = obterIdiomaSalvo();

const I18N_DICTIONARY = {
  "pt-BR": {
    "brand.aria": "EMAP · Painel Operacional",
    "brand.subtitle": "Painel Operacional · CCO",
    "nav.overview": "Visão Geral",
    "nav.movements": "Movimentações",
    "nav.carriers": "Transportadoras",
    "nav.reports": "Relatórios",
    "nav.vehicles": "Cadastro de Veículos",
    "nav.settings": "Configurações",
    "sidebar.monitoring": "Monitoramento operacional",

    "header.label": "Operação",
    "header.control_center": "Centro de Controle",
    "header.logout": "Sair",
    "header.lang_aria": "Selecionar idioma",
    "header.lang_pt_aria": "Mudar idioma para Português (Brasil)",
    "header.lang_en_aria": "Switch language to English (US)",

    "page.overview.title": "Visão Geral",
    "page.overview.subtitle": "Acompanhamento geral das movimentações e indicadores do terminal.",
    "page.movements.title": "Movimentações",
    "page.movements.subtitle": "Consulta detalhada por placa, transportadora, etapa e operação.",
    "page.carriers.title": "Transportadoras",
    "page.carriers.subtitle": "Indicadores e volume operacional por transportadora.",
    "page.reports.title": "Relatórios",
    "page.reports.subtitle": "Organize e consulte os relatórios operacionais.",
    "page.vehicles.title": "Cadastro de Veículos",
    "page.vehicles.subtitle": "Cadastre e gerencie os veículos da operação.",
    "page.settings.title": "Configurações",
    "page.settings.subtitle": "Preferências do painel e parâmetros operacionais.",

    "overview.executive_title": "Indicadores executivos",
    "overview.points_title": "Operações por ponto",
    "overview.conveyor_title": "Monitoramento Área Primária · Modal Convencional",
    "overview.conveyor_subtitle": "Giro de veículos por etapa de fluxo operacional",
    "primary_area.total": "Total na Área Primária",
    "primary_area.without_collector": "Sem passar no Coletor",
    "primary_area.between_collector_scale": "Entre Coletor e Balança",
    "primary_area.between_scale_pan": "Entre Balança e PAN",
    "primary_area.total_title": "Clique para filtrar todos os veículos na Área Primária",
    "primary_area.without_collector_title": "Clique para filtrar veículos sem passar no coletor (Fila PRC + Pátio)",
    "primary_area.between_collector_scale_title": "Clique para filtrar veículos em operação (entre coletor e balança)",
    "primary_area.between_scale_pan_title": "Clique para filtrar veículos de Balança (Tara/Bruto) e PAN",
    "primary_area.inspecting_title": "Inspecionando Área Primária",
    "kpi.active_vehicles": "Veículos ativos",
    "kpi.total_cargo": "Carga movimentada",
    "kpi.avg_time": "Tempo médio",
    "kpi.sla_rate": "Taxa SLA / Pontualidade",
    "kpi.in_operation_now": "Em operação no momento",
    "kpi.accumulated_period": "Acumulado do período",
    "kpi.avg_stay": "Permanência média no terminal",
    "kpi.within_target": "Dentro da meta operacional",
    "kpi.berth_load": "{n} t de carga em {v} veículos",
    "kpi.berth_active_suffix": "em operação",
    "kpi.stage_vehicles": "{n} veículos",

    "alerts.title": "Alertas de desvios operacionais",
    "alerts.subtitle": "Veículos e etapas com prioridade de acompanhamento pelo CCO.",
    "alerts.none": "Nenhum desvio operacional crítico detectado no momento.",
    "alerts.badge_critical": "Crítico",
    "alerts.badge_attention": "Atenção",
    "alerts.overweight": "Sobrepeso ({kg} kg)",
    "alerts.prc_retention": "Retenção PRC ({min} min)",
    "alerts.sla_attention": "Atenção SLA ({min} min)",
    "alerts.regular": "Regular",
    "alerts.item_meta": "{carrier} · {stage} · {dest} · {time}",
    "alerts.overweight_desc": "Peso {kg} kg acima do limite configurado ({limit} kg)",
    "alerts.prc_desc": "Permanência na Fila PRC ({min} min) acima do limite ({limit} min)",
    "alerts.sla_desc": "Tempo na etapa {stage} ({min} min) acima da atenção ({limit} min)",

    "chart.volume_title": "Movimentação por transportadora",
    "chart.volume_subtitle": "Comparativo de volume transportado por empresa",
    "chart.volume_unit": "Volume (t)",
    "chart.op_title": "Volume por tipo de operação",
    "chart.op_subtitle": "Distribuição entre recebimento e expedição",
    "chart.receiving": "Recebimento",
    "chart.dispatch": "Expedição",
    "chart.tooltip_ton": "{v} toneladas",
    "period.today": "Hoje",
    "period.7d": "Últimos 7 dias",
    "period.30d": "Últimos 30 dias",

    "conn.online_live": "API Online · Tempo Real",
    "conn.syncing": "Sincronizando com API...",
    "conn.offline": "API Offline (Modo Local)",
    "conn.last_sync": "Última sincronização às {time} (Brasília)",
    "conn.sync_now_success": "Painel sincronizado com a API FastAPI.",
    "conn.sync_now_offline": "API indisponível no momento. Exibindo dados locais/mock.",

    "common.export_csv": "Exportar CSV",
    "common.export_csv_arrow": "⬇ Exportar CSV",
    "common.close": "Fechar",
    "common.cancel": "Cancelar",
    "common.details": "Detalhes",
    "common.all": "Todos",
    "common.clear_filters": "✕ Limpar filtros",
    "common.undo": "Desfazer",
    "common.restore": "Restaurar",

    "movements.title": "Movimentações de Veículos",
    "movements.subtitle": "Acompanhe placa, transportadora, etapa atual, operação, origem/destino, peso e situação em tempo real.",
    "movements.restore_btn": "Restaurar excluídos ({n})",
    "movements.clear_filters": "✕ Limpar filtros",
    "movements.plate_filter_label": "Filtrar por placa",
    "movements.plate_filter_placeholder": "Ex.: ABC1D23",
    "movements.empty_filtered": "Nenhum veículo detalhado nesta seleção no momento — clique em 'Limpar filtros' para ver todos os veículos ativos.",
    "movements.empty_all": "Nenhum veículo encontrado para os filtros aplicados.",
    "movements.count_summary": "Exibindo {shown} de {total} movimentações ativas",
    "movements.inspect_berth": "Inspecionando {target}: {count} veículos detalhados na lista (resumo do card: {summaryCount} veículos).",
    "movements.inspect_stage": "Inspecionando etapa {target}: {count} veículos detalhados na lista (resumo do card: {summaryCount} veículos).",
    "movements.plate_tooltip": "Ver detalhes do Ticket iPort",
    "movements.remove_aria": "Remover veículo {plate} da operação",
    "movements.remove_btn": "Remover",
    "movements.delete_badge": "ATENÇÃO · EXCLUSÃO DE REGISTRO",
    "movements.delete_modal_title": "Confirmar remoção do veículo?",
    "movements.confirm_delete_btn": "Sim, remover",
    "movements.local_tag": "Local",
    "movements.api_tag": "API iPort",
    "movements.default_banner_title": "Contrato Oficial iPort · COPI001",
    "movements.default_banner_status": "Operação Ativa",
    "movements.default_banner_desc": "Acompanhamento contínuo de movimentações rodoviárias (Entrada e Saída) nas unidades COPISI, VM e TIPA · Janela operacional de 48h.",

    "filter.unit": "Unidade / Empresa",
    "filter.unit_all": "Todas as unidades",
    "filter.dest": "Destino / Berço",
    "filter.stage": "Etapa",
    "filter.carrier": "Transportadora",
    "filter.operation": "Tipo de operação",
    "filter.period": "Período",
    "filter.all_masc": "Todos",
    "filter.all_fem": "Todas",
    "filter.all_f": "Todas",

    "dest.berth99": "Berço 99",
    "dest.berth101": "Berço 101",
    "dest.berth102": "Berço 102",
    "dest.dispatch": "Expedição",
    "dest.yard": "Pátio",

    "stage.pan": "1. PAN (Triagem)",
    "stage.pan_short": "1. PAN (Triagem)",
    "stage.prc": "2. Fila PRC",
    "stage.tara": "3. Balança Tara",
    "stage.op": "4. Operação",
    "stage.op_berth": "4. Operação (Berço)",
    "stage.bruto": "5. Balança Bruto",
    "stage.gateout": "6. Gate-out",

    "op.receiving": "Recebimento",
    "op.dispatch": "Expedição",

    "status.transit": "Em trânsito",
    "status.completed": "Finalizado",
    "status.inbound": "Entrada",
    "status.outbound": "Saída",

    "table.plate": "Placa",
    "table.carrier": "Transportadora",
    "table.stage": "Etapa",
    "table.operation": "Operação",
    "table.dest": "Destino / Berço",
    "table.weight": "Peso (kg)",
    "table.status": "Situação",
    "table.alerts": "Alertas",
    "table.actions": "Ações",

    "carriers.title": "Transportadoras",
    "carriers.subtitle": "Compare o volume de veículos e os indicadores por transportadora (COPI001).",
    "carriers.search_label": "Buscar transportadora",
    "carriers.search_placeholder": "Ex.: Transporte Alfa, Translog...",
    "carriers.kpi_total": "Total de transportadoras",
    "carriers.kpi_total_obs": "Ativas na operação",
    "carriers.kpi_vehicles": "Veículos em operação",
    "carriers.kpi_volume_obs": "Volume total: {vol} t",
    "carriers.kpi_time": "Tempo médio de permanência",
    "carriers.kpi_sla_obs": "Monitoramento SLA ativo",
    "carriers.kpi_sla_crit": "{n} transportadora(s) com alerta crítico",
    "carriers.panel_title": "Desempenho por transportadora",
    "carriers.panel_subtitle": "Indicadores consolidados por transportadora.",
    "carriers.panel_subtitle_filtered": "Exibindo {n} transportadora(s) · Unidade: {unit} · Operação: {op}",
    "carriers.th_carrier": "Transportadora",
    "carriers.th_vehicles": "Veículos em operação",
    "carriers.th_volume": "Volume Total (kg / t)",
    "carriers.th_avg_time": "Tempo médio (min)",
    "carriers.th_units": "Unidades atendidas",
    "carriers.th_sla": "Status de SLA",
    "carriers.th_action": "Ação",
    "carriers.view_vehicles": "Ver veículos →",
    "carriers.empty": "Nenhuma transportadora encontrada para os filtros selecionados.",

    "reports.title": "Relatórios",
    "reports.subtitle": "Organize consultas e relatórios operacionais.",
    "reports.type_label": "Tipo de relatório",
    "reports.card_movement.title": "Movimentação de carga",
    "reports.card_movement.desc": "Consulta das movimentações de entrada e saída de carga.",
    "reports.card_movement.note": "Disponibilidade e campos a confirmar com a API",
    "reports.card_receiving.title": "Recebimento de carga",
    "reports.card_receiving.desc": "Detalhamento das operações de recebimento.",
    "reports.card_receiving.note": "Unidades e filtros conforme documentação",
    "reports.card_dispatch.title": "Expedição de carga",
    "reports.card_dispatch.desc": "Detalhamento das operações de expedição.",
    "reports.card_dispatch.note": "Unidades e filtros conforme documentação",
    "reports.card_stock.title": "Estoque atual",
    "reports.card_stock.desc": "Consulta de situação do estoque no terminal.",
    "reports.card_stock.note": "Confirmar se faz parte do escopo do painel",
    "reports.card_manifest_vs_actual.title": "Conferência de Manifestado × Realizado",
    "reports.card_manifest_vs_actual.desc": "Controle de teto operacional e saldo restante por lote e documento.",
    "reports.card_manifest_vs_actual.note": "Controle de teto por DI/BL e cliente",
    "reports.card_vehicles.title": "Relatório de veículos",
    "reports.card_vehicles.desc": "Lista de veículos por período, transportadora e etapa.",
    "reports.card_vehicles.note": "Proposta de relatório para o novo painel",
    "reports.count_records": "{n} registro(s) · {vol} t · Unidade: {unit}",
    "reports.count_stock": "{n} ponto(s)/lote(s) · {vol} t · Unidade: {unit}",
    "reports.count_manifest_vs_actual": "{n} lote(s) · {alertas} no teto/excedente · Unidade: {unit}",
    "reports.window_note": "ℹ Janela operacional de consulta limitada a 48h conforme integração com a API iPort (COPI001).",
    "reports.csv_exported": "CSV do relatório '{title}' exportado com {n} linha(s).",
    "reports.csv_empty": "Não há registros para exportar neste relatório.",
    "period.24h": "Últimas 24h",
    "period.48h": "Últimas 48h",

    "report_modal.title": "Detalhes do Relatório",
    "report_modal.close_aria": "Fechar detalhes do relatório",
    "report_modal.kpi_records": "Registros",
    "report_modal.kpi_volume": "Volume Total",
    "report_modal.kpi_avg_time": "Tempo Médio",
    "report_modal.kpi_alerts": "Alertas Críticos",
    "report_modal.note_stock": "Resumo consolidado por ponto operacional / berço e cliente com base nos veículos ativos.",
    "report_modal.empty": "Nenhum registro encontrado para os filtros aplicados.",

    "vehicles.title": "Cadastro de Veículos",
    "vehicles.subtitle": "Cadastre e gerencie os veículos da operação. Os veículos cadastrados aqui são mantidos localmente e sincronizados com as tabelas de Movimentações, Visão Geral e Transportadoras.",
    "vehicles.plate_label": "Placa do veículo *",
    "vehicles.plate_placeholder": "Ex.: ABC1D23 ou ABC-1234",
    "vehicles.carrier_label": "Transportadora *",
    "vehicles.carrier_placeholder": "Nome da transportadora",
    "vehicles.type_label": "Tipo de veículo",
    "vehicles.type_carreta": "Carreta (6 eixos)",
    "vehicles.type_bitrem": "Bitrem (7 eixos)",
    "vehicles.type_rodotrem": "Rodotrem (9 eixos)",
    "vehicles.type_truck": "Caminhão (4 eixos)",
    "vehicles.type_other": "Outro",
    "vehicles.op_label": "Tipo de operação",
    "vehicles.op_receiving": "Recebimento (Descarga)",
    "vehicles.op_dispatch": "Expedição (Carregamento)",
    "vehicles.dest_label": "Destino / Berço",
    "vehicles.stage_label": "Etapa inicial",
    "vehicles.weight_label": "Peso / Carga líquida (kg)",
    "vehicles.weight_placeholder": "Ex.: 32000",
    "vehicles.unit_label": "Unidade / Empresa (iPort)",
    "vehicles.driver_label": "Motorista",
    "vehicles.driver_placeholder": "Ex.: Carlos Mendes",
    "vehicles.client_label": "Cliente",
    "vehicles.client_placeholder": "Ex.: Vale S.A. / Suzano / Raízen",
    "vehicles.obs_label": "Navio / Documento do Lote (DI / BL)",
    "vehicles.obs_placeholder": "Ex.: PRESTIGE DIVA · BL-ITQ-2026-103",
    "vehicles.required_hint": "* Campos obrigatórios para liberar o veículo no giro.",
    "vehicles.submit": "Cadastrar veículo na operação",
    "vehicles.local_title": "Veículos cadastrados localmente",
    "vehicles.local_desc": "Registros salvos neste navegador e mesclados automaticamente com a API.",
    "vehicles.clear_local": "Limpar cadastros locais",
    "vehicles.empty_local": "Nenhum veículo cadastrado localmente nesta sessão.",
    "vehicles.err_required": "Informe a placa e a transportadora para cadastrar o veículo.",
    "vehicles.err_plate": "Formato de placa inválido. Use ABC1D23 (Mercosul) ou ABC-1234.",
    "vehicles.err_duplicate": "A placa {plate} já está ativa na operação.",
    "vehicles.success_added": "Veículo {plate} ({carrier}) cadastrado em {stage} ({dest}).",
    "vehicles.cleared_local": "Todos os cadastros locais foram removidos.",

    "settings.title": "Configurações Operacionais do CCO",
    "settings.subtitle": "Ajuste os limiares de SLA, alertas críticos (COPI001) e sincronização com a API.",
    "settings.params.title": "Parâmetros Operacionais e Polling da API",
    "settings.params.desc": "Defina os limites para cálculo automático de alertas críticos de Sobrepeso e Retenção PRC, além do intervalo de atualização em tempo real.",
    "settings.overweight.label": "Limite de Sobrepeso (kg)",
    "settings.overweight.desc": "Acima deste peso bruto/movimentado o veículo entra em alerta crítico de Sobrepeso (padrão: 48.500 kg).",
    "settings.prc.label": "Limite de Retenção PRC (min)",
    "settings.prc.desc": "Tempo máximo de permanência na Fila PRC antes de gerar alerta crítico de retenção (padrão: 120 min).",
    "settings.polling.label": "Intervalo de Polling da API (segundos)",
    "settings.polling.desc": "Frequência de sincronização automática com os 5 endpoints FastAPI (padrão: 30s).",
    "settings.btn_save": "Salvar configurações",
    "settings.btn_sync": "↻ Sincronizar agora",
    "settings.btn_reset": "Restaurar padrões",
    "settings.notifications.title": "Notificações",
    "settings.notifications.desc": "Escolha quais avisos deseja visualizar nesta interface operacional.",
    "settings.notify_alerts.label": "Alertas de desvios operacionais",
    "settings.notify_alerts.desc": "Exibir avisos sobre situações fora dos limites de SLA e balança.",
    "settings.notify_updates.label": "Atualizações do painel",
    "settings.notify_updates.desc": "Mostrar indicação de sincronização dos dados com a API.",
    "settings.notify_email.label": "Relatórios por e-mail",
    "settings.notify_email.desc": "Preferência visual; envio automático via servidor.",
    "settings.visual.title": "Visualização",
    "settings.visual.desc": "Ajustes locais para a aparência do painel CCO.",
    "settings.theme.label": "Tema",
    "settings.theme.desc": "Alternar entre tema claro e escuro.",
    "settings.theme.light": "Claro",
    "settings.theme.dark": "Escuro",
    "settings.language.label": "Idioma",
    "settings.language.desc": "Idioma dos textos da interface.",
    "settings.language.aria": "Idioma da interface",
    "settings.saved_msg": "Configurações salvas! Limite Sobrepeso: {overweight} kg · Retenção PRC: {prc} min · Polling: {polling}s.",
    "settings.reset_msg": "Parâmetros operacionais restaurados para o padrão COPI001.",
    "settings.err_invalid": "Verifique os valores numéricos informados (Polling mínimo: 5s).",
    "settings.session.title": "Sessão do operador",
    "settings.session.desc": "Operador autenticado neste terminal e encerramento de acesso.",
    "settings.session.logout": "Sair",

    "modal.iport_contract": "Contrato Oficial iPort · COPI001",
    "confirm_remove.title": "Confirmar remoção",
    "confirm_remove.default_msg": "Você tem certeza que deseja remover este veículo?",
    "confirm_remove.msg_plate": "Deseja remover o veículo {plate} da operação ativa?",
    "confirm_remove.submit": "Sim, remover",
    "confirm_remove.source_local": "Cadastro local",
    "confirm_remove.source_api": "API iPort",

    "restore_modal.title": "Restaurar veículos excluídos",
    "restore_modal.desc": "Selecione individualmente qual registro deseja voltar para a operação ou restaure todos de uma vez.",
    "restore_modal.restore_all": "Restaurar todos ({n})",
    "restore_modal.restore_one": "Restaurar",
    "restore_modal.empty": "Nenhum veículo excluído nesta sessão.",
    "restore_modal.removed_at": "Excluído às {time}",
    "restore_modal.restored_one": "Veículo {plate} restaurado para a operação.",
    "restore_modal.restored_all": "{n} veículo(s) restaurado(s) para a operação.",
    "undo.banner_text": "Veículo {plate} ({carrier}) removido da operação.",

    "ticket_modal.title": "Detalhes do Ticket de Movimentação",
    "ticket_modal.close_aria": "Fechar detalhes do ticket",
    "ticket_modal.sec_identification": "Identificação e Operação",
    "ticket_modal.sec_weighing": "Pesagem e Carga (kg)",
    "ticket_modal.sec_cargo": "Lote, Navio e Cliente",
    "ticket_modal.sec_times": "Tempos e Auditoria CCO",
    "ticket_modal.ticket_num": "Ticket iPort",
    "ticket_modal.unit": "Unidade / Empresa",
    "ticket_modal.plate": "Placa",
    "ticket_modal.driver": "Motorista",
    "ticket_modal.carrier": "Transportadora",
    "ticket_modal.vehicle_type": "Tipo de Veículo",
    "ticket_modal.operation": "Operação / Sentido",
    "ticket_modal.stage": "Etapa Atual",
    "ticket_modal.dest": "Destino / Berço",
    "ticket_modal.tare": "Peso Tara",
    "ticket_modal.gross": "Peso Bruto",
    "ticket_modal.net": "Peso Líquido / Movimentado",
    "ticket_modal.client": "Cliente",
    "ticket_modal.product": "Produto / Carga",
    "ticket_modal.vessel": "Navio",
    "ticket_modal.doc": "Documento (DI / BL)",
    "ticket_modal.stay": "Permanência",
    "ticket_modal.status": "Situação",
    "ticket_modal.alerts": "Alertas",
    "ticket_modal.origin": "Origem do Registro",
    "ticket.copy_summary": "Copiar resumo",
    "ticket.copied": "Copiado!",

    "footer.left": "Protótipo de interface · COPI",
    "footer.right": "Dados fictícios — integração com API pendente",

    // Chaves complementares usadas no index.html
    "chart.flow_title": "Fluxo de veículos no terminal",
    "chart.flow_subtitle": "Movimentações ao longo do dia",
    "chart.carriers_title": "Veículos por transportadora",
    "chart.carriers_subtitle": "Distribuição das movimentações",
    "chart.vehicles_label": "veículos",
    "dest.expedicao": "Expedição",
    "filter.all_m": "Todos",
    "filter.all_f": "Todas",
    "filter.all_units": "Todas as unidades",
    "filter.clear": "✕ Limpar filtros",
    "filter.destination": "Destino (Berço)",
    "filter.plate": "Placa",
    "kpi.alerts": "Alertas críticos",
    "kpi.cycle": "Veículos no giro",
    "kpi.shipped": "Total expedido",
    "kpi.unloaded": "Total descarregado",
    "movements.table_title": "Registros de movimentação",
    "op.expedicao": "Expedição",
    "op.recebimento": "Recebimento",
    "stage.1": "1. PAN",
    "stage.2": "2. Fila PRC",
    "stage.3": "3. Balança Tara",
    "stage.4": "4. Operação",
    "stage.5": "5. Balança Bruto",
    "stage.6": "6. Gate-out",
    "table.destination": "Destino (Berço)",
    "table.duration": "Tempo / Permanência",
    "filter.plate_placeholder": "Ex.: ABC-1234",
    "chart.flow_aria": "Gráfico de fluxo de veículos",
    "lang.aria": "Selecionar idioma",
    "nav.aria": "Menu principal"
  },
  "en-US": {
    "brand.aria": "EMAP · Operations Dashboard",
    "brand.subtitle": "Operations Dashboard · CCO",
    "nav.overview": "Overview",
    "nav.movements": "Movements",
    "nav.carriers": "Carriers",
    "nav.reports": "Reports",
    "nav.vehicles": "Register Vehicles",
    "nav.settings": "Settings",
    "sidebar.monitoring": "Operational monitoring",

    "header.label": "Operations",
    "header.control_center": "Control Center",
    "header.logout": "Sign out",
    "header.lang_aria": "Select language",
    "header.lang_pt_aria": "Mudar idioma para Português (Brasil)",
    "header.lang_en_aria": "Switch language to English (US)",

    "page.overview.title": "Overview",
    "page.overview.subtitle": "General tracking of terminal movements and operational KPIs.",
    "page.movements.title": "Movements",
    "page.movements.subtitle": "Detailed search by license plate, carrier, stage, and operation.",
    "page.carriers.title": "Carriers",
    "page.carriers.subtitle": "Operational indicators and volume by carrier.",
    "page.reports.title": "Reports",
    "page.reports.subtitle": "Organize and inspect operational reports.",
    "page.vehicles.title": "Register Vehicles",
    "page.vehicles.subtitle": "Register and manage vehicles in the operation.",
    "page.settings.title": "Settings",
    "page.settings.subtitle": "Dashboard preferences and operational parameters.",

    "overview.executive_title": "Executive KPIs",
    "overview.points_title": "Operations by point",
    "overview.conveyor_title": "Primary Area Monitoring · Conventional Mode",
    "overview.conveyor_subtitle": "Vehicle turnaround by operational flow stage",
    "primary_area.total": "Total in Primary Area",
    "primary_area.without_collector": "Without Collector Passage",
    "primary_area.between_collector_scale": "Between Collector and Scale",
    "primary_area.between_scale_pan": "Between Scale and PAN",
    "primary_area.total_title": "Click to filter all vehicles in the Primary Area",
    "primary_area.without_collector_title": "Click to filter vehicles without collector passage (PRC Queue + Yard)",
    "primary_area.between_collector_scale_title": "Click to filter vehicles in operation (between collector and scale)",
    "primary_area.between_scale_pan_title": "Click to filter scale (Tare/Gross) and PAN vehicles",
    "primary_area.inspecting_title": "Inspecting Primary Area",
    "kpi.active_vehicles": "Active vehicles",
    "kpi.total_cargo": "Cargo moved",
    "kpi.avg_time": "Average time",
    "kpi.sla_rate": "SLA / On-time rate",
    "kpi.in_operation_now": "Currently in operation",
    "kpi.accumulated_period": "Period total",
    "kpi.avg_stay": "Average terminal dwell time",
    "kpi.within_target": "Within operational target",
    "kpi.berth_load": "{n} t cargo across {v} vehicles",
    "kpi.berth_active_suffix": "in operation",
    "kpi.stage_vehicles": "{n} vehicles",

    "alerts.title": "Operational deviation alerts",
    "alerts.subtitle": "Vehicles and stages prioritized for CCO monitoring.",
    "alerts.none": "No critical operational deviations detected at this time.",
    "alerts.badge_critical": "Critical",
    "alerts.badge_attention": "Warning",
    "alerts.overweight": "Overweight ({kg} kg)",
    "alerts.prc_retention": "PRC Retention ({min} min)",
    "alerts.sla_attention": "SLA Warning ({min} min)",
    "alerts.regular": "Normal",
    "alerts.item_meta": "{carrier} · {stage} · {dest} · {time}",
    "alerts.overweight_desc": "Weight {kg} kg above configured limit ({limit} kg)",
    "alerts.prc_desc": "Dwell time in PRC Queue ({min} min) above limit ({limit} min)",
    "alerts.sla_desc": "Time in stage {stage} ({min} min) above warning threshold ({limit} min)",

    "chart.volume_title": "Volume by carrier",
    "chart.volume_subtitle": "Comparison of cargo volume moved per carrier",
    "chart.volume_unit": "Volume (t)",
    "chart.op_title": "Volume by operation type",
    "chart.op_subtitle": "Distribution between receiving and dispatch",
    "chart.receiving": "Receiving",
    "chart.dispatch": "Dispatch",
    "chart.tooltip_ton": "{v} tons",
    "period.today": "Today",
    "period.7d": "Last 7 days",
    "period.30d": "Last 30 days",

    "conn.online_live": "API Online · Real Time",
    "conn.syncing": "Syncing with API...",
    "conn.offline": "API Offline (Local Mode)",
    "conn.last_sync": "Last sync at {time} (Brasília)",
    "conn.sync_now_success": "Dashboard synced with FastAPI.",
    "conn.sync_now_offline": "API unavailable right now. Showing local/mock data.",

    "common.export_csv": "Export CSV",
    "common.export_csv_arrow": "⬇ Export CSV",
    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.details": "Details",
    "common.all": "All",
    "common.clear_filters": "✕ Clear filters",
    "common.undo": "Undo",
    "common.restore": "Restore",

    "movements.title": "Vehicle Movements",
    "movements.subtitle": "Track license plate, carrier, current stage, operation, origin/destination, weight, and status in real time.",
    "movements.restore_btn": "Restore deleted ({n})",
    "movements.clear_filters": "✕ Clear filters",
    "movements.plate_filter_label": "Filter by plate",
    "movements.plate_filter_placeholder": "e.g. ABC1D23",
    "movements.empty_filtered": "No detailed vehicles in this selection right now — click 'Clear filters' to view all active vehicles.",
    "movements.empty_all": "No vehicles found for the applied filters.",
    "movements.count_summary": "Showing {shown} of {total} active movements",
    "movements.inspect_berth": "Inspecting {target}: {count} detailed vehicles in list (card summary: {summaryCount} vehicles).",
    "movements.inspect_stage": "Inspecting stage {target}: {count} detailed vehicles in list (card summary: {summaryCount} vehicles).",
    "movements.plate_tooltip": "View iPort Ticket details",
    "movements.remove_aria": "Remove vehicle {plate} from operation",
    "movements.remove_btn": "Remove",
    "movements.delete_badge": "WARNING · RECORD DELETION",
    "movements.delete_modal_title": "Confirm vehicle removal?",
    "movements.confirm_delete_btn": "Yes, remove",
    "movements.local_tag": "Local",
    "movements.api_tag": "iPort API",
    "movements.default_banner_title": "Official iPort Contract · COPI001",
    "movements.default_banner_status": "Active Operation",
    "movements.default_banner_desc": "Continuous monitoring of road cargo movements (Inbound and Outbound) across COPISI, VM, and TIPA units · 48h operational window.",

    "filter.unit": "Unit / Company",
    "filter.unit_all": "All units",
    "filter.dest": "Destination / Berth",
    "filter.stage": "Stage",
    "filter.carrier": "Carrier",
    "filter.operation": "Operation type",
    "filter.period": "Period",
    "filter.all_masc": "All",
    "filter.all_fem": "All",
    "filter.all_f": "All",

    "dest.berth99": "Berth 99",
    "dest.berth101": "Berth 101",
    "dest.berth102": "Berth 102",
    "dest.dispatch": "Dispatch",
    "dest.yard": "Yard",

    "stage.pan": "1. PAN (Screening)",
    "stage.pan_short": "1. PAN (Screening)",
    "stage.prc": "2. PRC Queue",
    "stage.tara": "3. Tare Scale",
    "stage.op": "4. Operation",
    "stage.op_berth": "4. Operation (Berth)",
    "stage.bruto": "5. Gross Scale",
    "stage.gateout": "6. Gate-out",

    "op.receiving": "Receiving",
    "op.dispatch": "Dispatch",

    "status.transit": "In transit",
    "status.completed": "Completed",
    "status.inbound": "Inbound",
    "status.outbound": "Outbound",

    "table.plate": "Plate",
    "table.carrier": "Carrier",
    "table.stage": "Stage",
    "table.operation": "Operation",
    "table.dest": "Destination / Berth",
    "table.weight": "Weight (kg)",
    "table.status": "Status",
    "table.alerts": "Alerts",
    "table.actions": "Actions",

    "carriers.title": "Carriers",
    "carriers.subtitle": "Compare vehicle volume and operational KPIs by carrier (COPI001).",
    "carriers.search_label": "Search carrier",
    "carriers.search_placeholder": "e.g. Transporte Alfa, Translog...",
    "carriers.kpi_total": "Total carriers",
    "carriers.kpi_total_obs": "Active in operation",
    "carriers.kpi_vehicles": "Vehicles in operation",
    "carriers.kpi_volume_obs": "Total volume: {vol} t",
    "carriers.kpi_time": "Average dwell time",
    "carriers.kpi_sla_obs": "SLA monitoring active",
    "carriers.kpi_sla_crit": "{n} carrier(s) with critical alert",
    "carriers.panel_title": "Performance by carrier",
    "carriers.panel_subtitle": "Consolidated operational KPIs per carrier.",
    "carriers.panel_subtitle_filtered": "Showing {n} carrier(s) · Unit: {unit} · Operation: {op}",
    "carriers.th_carrier": "Carrier",
    "carriers.th_vehicles": "Vehicles in operation",
    "carriers.th_volume": "Total Volume (kg / t)",
    "carriers.th_avg_time": "Avg time (min)",
    "carriers.th_units": "Units served",
    "carriers.th_sla": "SLA Status",
    "carriers.th_action": "Action",
    "carriers.view_vehicles": "View vehicles →",
    "carriers.empty": "No carriers found for the selected filters.",

    "reports.title": "Reports",
    "reports.subtitle": "Organize operational queries and reports.",
    "reports.type_label": "Report type",
    "reports.card_movement.title": "Cargo movement",
    "reports.card_movement.desc": "Query of inbound and outbound cargo movements.",
    "reports.card_movement.note": "Availability and fields synced with API",
    "reports.card_receiving.title": "Cargo receiving",
    "reports.card_receiving.desc": "Breakdown of receiving operations.",
    "reports.card_receiving.note": "Units and filters per documentation",
    "reports.card_dispatch.title": "Cargo dispatch",
    "reports.card_dispatch.desc": "Breakdown of dispatch operations.",
    "reports.card_dispatch.note": "Units and filters per documentation",
    "reports.card_stock.title": "Current stock",
    "reports.card_stock.desc": "Terminal stock status overview.",
    "reports.card_stock.note": "Consolidated by berth and client",
    "reports.card_manifest_vs_actual.title": "Manifested vs. Actual Reconciliation",
    "reports.card_manifest_vs_actual.desc": "Operational ceiling control and remaining balance per batch and document.",
    "reports.card_manifest_vs_actual.note": "Ceiling control by DI/BL and client",
    "reports.card_vehicles.title": "Vehicle report",
    "reports.card_vehicles.desc": "List of vehicles by period, carrier, and stage.",
    "reports.card_vehicles.note": "Operational report for CCO panel",
    "reports.count_records": "{n} record(s) · {vol} t · Unit: {unit}",
    "reports.count_stock": "{n} point(s)/batch(es) · {vol} t · Unit: {unit}",
    "reports.count_manifest_vs_actual": "{n} batch(es) · {alertas} at/exceeded ceiling · Unit: {unit}",
    "reports.window_note": "ℹ Operational query window limited to 48h per iPort API integration (COPI001).",
    "reports.csv_exported": "CSV for report '{title}' exported with {n} row(s).",
    "reports.csv_empty": "There are no records to export in this report.",
    "period.24h": "Last 24h",
    "period.48h": "Last 48h",

    "report_modal.title": "Report Details",
    "report_modal.close_aria": "Close report details",
    "report_modal.kpi_records": "Records",
    "report_modal.kpi_volume": "Total Volume",
    "report_modal.kpi_avg_time": "Avg Time",
    "report_modal.kpi_alerts": "Critical Alerts",
    "report_modal.note_stock": "Summary consolidated by operational point / berth and client based on active vehicles.",
    "report_modal.empty": "No records found for the applied filters.",

    "vehicles.title": "Register Vehicles",
    "vehicles.subtitle": "Register and manage operational vehicles. Vehicles registered here are stored locally and merged with the Movements, Overview, and Carriers tables.",
    "vehicles.plate_label": "License plate *",
    "vehicles.plate_placeholder": "e.g. ABC1D23 or ABC-1234",
    "vehicles.carrier_label": "Carrier *",
    "vehicles.carrier_placeholder": "Carrier name",
    "vehicles.type_label": "Vehicle type",
    "vehicles.type_carreta": "Semi-trailer (6 axles)",
    "vehicles.type_bitrem": "B-double (7 axles)",
    "vehicles.type_rodotrem": "Road train (9 axles)",
    "vehicles.type_truck": "Truck (4 axles)",
    "vehicles.type_other": "Other",
    "vehicles.op_label": "Operation type",
    "vehicles.op_receiving": "Receiving (Unloading)",
    "vehicles.op_dispatch": "Dispatch (Loading)",
    "vehicles.dest_label": "Destination / Berth",
    "vehicles.stage_label": "Initial stage",
    "vehicles.weight_label": "Weight / Net cargo (kg)",
    "vehicles.weight_placeholder": "e.g. 32000",
    "vehicles.unit_label": "Unit / Company (iPort)",
    "vehicles.driver_label": "Driver",
    "vehicles.driver_placeholder": "e.g. Carlos Mendes",
    "vehicles.client_label": "Client",
    "vehicles.client_placeholder": "e.g. Vale S.A. / Suzano / Raízen",
    "vehicles.obs_label": "Vessel / Batch Document (DI / BL)",
    "vehicles.obs_placeholder": "e.g. PRESTIGE DIVA · BL-ITQ-2026-103",
    "vehicles.required_hint": "* Required fields to release the vehicle into operation.",
    "vehicles.submit": "Register vehicle in operation",
    "vehicles.local_title": "Locally registered vehicles",
    "vehicles.local_desc": "Records saved in this browser and automatically merged with the API.",
    "vehicles.clear_local": "Clear local registrations",
    "vehicles.empty_local": "No vehicles registered locally in this session.",
    "vehicles.err_required": "Enter the license plate and carrier to register the vehicle.",
    "vehicles.err_plate": "Invalid license plate format. Use ABC1D23 (Mercosur) or ABC-1234.",
    "vehicles.err_duplicate": "License plate {plate} is already active in the operation.",
    "vehicles.success_added": "Vehicle {plate} ({carrier}) registered at {stage} ({dest}).",
    "vehicles.cleared_local": "All local registrations have been removed.",

    "settings.title": "CCO Operational Settings",
    "settings.subtitle": "Adjust SLA thresholds, critical alerts (COPI001), and API synchronization.",
    "settings.params.title": "Operational Parameters & API Polling",
    "settings.params.desc": "Set thresholds for automatic Overweight and PRC Retention critical alerts, as well as real-time polling interval.",
    "settings.overweight.label": "Overweight Limit (kg)",
    "settings.overweight.desc": "Above this gross/moved weight, the vehicle triggers a critical Overweight alert (default: 48,500 kg).",
    "settings.prc.label": "PRC Retention Limit (min)",
    "settings.prc.desc": "Maximum dwell time in the PRC Queue before triggering a critical retention alert (default: 120 min).",
    "settings.polling.label": "API Polling Interval (seconds)",
    "settings.polling.desc": "Automatic synchronization frequency with the 5 FastAPI endpoints (default: 30s).",
    "settings.btn_save": "Save settings",
    "settings.btn_sync": "↻ Sync now",
    "settings.btn_reset": "Restore defaults",
    "settings.notifications.title": "Notifications",
    "settings.notifications.desc": "Choose which alerts to display in this operational interface.",
    "settings.notify_alerts.label": "Operational deviation alerts",
    "settings.notify_alerts.desc": "Show warnings about SLA and scale limit violations.",
    "settings.notify_updates.label": "Dashboard updates",
    "settings.notify_updates.desc": "Show API data synchronization indicator.",
    "settings.notify_email.label": "Email reports",
    "settings.notify_email.desc": "Visual preference; automatic delivery via server.",
    "settings.visual.title": "Display",
    "settings.visual.desc": "Local appearance preferences for the CCO dashboard.",
    "settings.theme.label": "Theme",
    "settings.theme.desc": "Switch between light and dark theme.",
    "settings.theme.light": "Light",
    "settings.theme.dark": "Dark",
    "settings.language.label": "Language",
    "settings.language.desc": "Interface text language.",
    "settings.language.aria": "Interface language",
    "settings.saved_msg": "Settings saved! Overweight limit: {overweight} kg · PRC Retention: {prc} min · Polling: {polling}s.",
    "settings.reset_msg": "Operational parameters restored to COPI001 defaults.",
    "settings.err_invalid": "Check the numeric values entered (minimum Polling: 5s).",
    "settings.session.title": "Operator session",
    "settings.session.desc": "Authenticated operator on this terminal and access sign-out.",
    "settings.session.logout": "Sign out",

    "modal.iport_contract": "Official iPort Contract · COPI001",
    "confirm_remove.title": "Confirm removal",
    "confirm_remove.default_msg": "Are you sure you want to remove this vehicle?",
    "confirm_remove.msg_plate": "Remove vehicle {plate} from active operation?",
    "confirm_remove.submit": "Yes, remove",
    "confirm_remove.source_local": "Local registration",
    "confirm_remove.source_api": "iPort API",

    "restore_modal.title": "Restore deleted vehicles",
    "restore_modal.desc": "Select an individual record to return to operation or restore all at once.",
    "restore_modal.restore_all": "Restore all ({n})",
    "restore_modal.restore_one": "Restore",
    "restore_modal.empty": "No vehicles deleted in this session.",
    "restore_modal.removed_at": "Deleted at {time}",
    "restore_modal.restored_one": "Vehicle {plate} restored to operation.",
    "restore_modal.restored_all": "{n} vehicle(s) restored to operation.",
    "undo.banner_text": "Vehicle {plate} ({carrier}) removed from operation.",

    "ticket_modal.title": "Movement Ticket Details",
    "ticket_modal.close_aria": "Close ticket details",
    "ticket_modal.sec_identification": "Identification & Operation",
    "ticket_modal.sec_weighing": "Weighing & Cargo (kg)",
    "ticket_modal.sec_cargo": "Batch, Vessel & Client",
    "ticket_modal.sec_times": "Times & CCO Audit",
    "ticket_modal.ticket_num": "iPort Ticket",
    "ticket_modal.unit": "Unit / Company",
    "ticket_modal.plate": "Plate",
    "ticket_modal.driver": "Driver",
    "ticket_modal.carrier": "Carrier",
    "ticket_modal.vehicle_type": "Vehicle Type",
    "ticket_modal.operation": "Operation / Direction",
    "ticket_modal.stage": "Current Stage",
    "ticket_modal.dest": "Destination / Berth",
    "ticket_modal.tare": "Tare Weight",
    "ticket_modal.gross": "Gross Weight",
    "ticket_modal.net": "Net / Moved Weight",
    "ticket_modal.client": "Client",
    "ticket_modal.product": "Product / Cargo",
    "ticket_modal.vessel": "Vessel",
    "ticket_modal.doc": "Document (DI / BL)",
    "ticket_modal.stay": "Dwell Time",
    "ticket_modal.status": "Status",
    "ticket_modal.alerts": "Alerts",
    "ticket_modal.origin": "Record Source",
    "ticket.copy_summary": "Copy summary",
    "ticket.copied": "Copied!",

    "footer.left": "Interface prototype · COPI",
    "footer.right": "Sample data — API integration",

    // Supplementary keys used in index.html
    "chart.flow_title": "Vehicle flow in the terminal",
    "chart.flow_subtitle": "Movements throughout the day",
    "chart.carriers_title": "Vehicles by carrier",
    "chart.carriers_subtitle": "Distribution of movements",
    "chart.vehicles_label": "vehicles",
    "dest.expedicao": "Dispatch",
    "filter.all_m": "All",
    "filter.all_f": "All",
    "filter.all_units": "All units",
    "filter.clear": "✕ Clear filters",
    "filter.destination": "Destination (Berth)",
    "filter.plate": "Plate",
    "kpi.alerts": "Critical alerts",
    "kpi.cycle": "Vehicles in cycle",
    "kpi.shipped": "Total dispatched",
    "kpi.unloaded": "Total unloaded",
    "movements.table_title": "Movement records",
    "op.expedicao": "Dispatch",
    "op.recebimento": "Receiving",
    "stage.1": "1. PAN",
    "stage.2": "2. PRC Queue",
    "stage.3": "3. Tare Scale",
    "stage.4": "4. Operation",
    "stage.5": "5. Gross Scale",
    "stage.6": "6. Gate-out",
    "table.destination": "Destination (Berth)",
    "table.duration": "Time / Dwell",
    "filter.plate_placeholder": "e.g. ABC-1234",
    "chart.flow_aria": "Vehicle flow chart",
    "lang.aria": "Select language",
    "nav.aria": "Main menu"
  }
};

function t(key, params = {}) {
  const dict = I18N_DICTIONARY[idiomaAtual] || I18N_DICTIONARY["pt-BR"];
  const fallback = I18N_DICTIONARY["pt-BR"];
  let text = dict[key] !== undefined ? dict[key] : (fallback[key] !== undefined ? fallback[key] : key);
  if (params && typeof text === "string") {
    Object.keys(params).forEach((k) => {
      text = text.replaceAll(`{${k}}`, String(params[k]));
    });
  }
  return text;
}

function traduzirEtapa(etapa) {
  if (idiomaAtual !== "en-US" || !etapa) return etapa || "—";
  const mapa = {
    "PAN": "PAN (Screening)",
    "1. PAN": "1. PAN (Screening)",
    "1. PAN (Triagem)": "1. PAN (Screening)",
    "Fila PRC": "PRC Queue",
    "2. Fila PRC": "2. PRC Queue",
    "Balança Tara": "Tare Scale",
    "3. Balança Tara": "3. Tare Scale",
    "Operação": "Operation",
    "4. Operação": "4. Operation",
    "4. Operação (Berço)": "4. Operation (Berth)",
    "Balança Bruto": "Gross Scale",
    "5. Balança Bruto": "5. Gross Scale",
    "Gate-out": "Gate-out",
    "6. Gate-out": "6. Gate-out"
  };
  return mapa[etapa] || etapa;
}

function traduzirOperacao(op) {
  if (idiomaAtual !== "en-US" || !op) return op || "—";
  if (op === "Recebimento") return t("op.receiving");
  if (op === "Expedição") return t("op.dispatch");
  if (op === "Entrada") return t("status.inbound");
  if (op === "Saída") return t("status.outbound");
  return op;
}

function traduzirSituacao(sit) {
  if (!sit) return "—";
  if (idiomaAtual !== "en-US") return sit;
  const s = String(sit).trim();
  if (s === "Em trânsito") return t("status.transit");
  if (s === "Finalizado") return t("status.completed");
  if (s === "Entrada") return t("status.inbound");
  if (s === "Saída") return t("status.outbound");
  if (s === "Regular") return t("alerts.regular");
  if (s.toLowerCase() === "na meta") return "On target";
  if (s.toLowerCase() === "abaixo da norma") return "Below standard";
  if (s.toLowerCase() === "crítico" || s.toLowerCase() === "critico") return "Critical";
  if (s.toLowerCase() === "atenção" || s.toLowerCase() === "atencao") return "Warning";
  return s;
}

function traduzirDestino(dest) {
  if (!dest) return "—";
  if (idiomaAtual !== "en-US") return dest;
  const d = String(dest).trim();
  if (/^ber[çc]o\s*99$/i.test(d)) return "Berth 99";
  if (/^ber[çc]o\s*101$/i.test(d)) return "Berth 101";
  if (/^ber[çc]o\s*102$/i.test(d)) return "Berth 102";
  if (/^ber[çc]o\s+/i.test(d)) return d.replace(/^ber[çc]o\s+/i, "Berth ");
  if (/^expedi[çc][ãa]o$/i.test(d)) return t("dest.dispatch");
  if (d === "Pátio") return t("dest.yard");
  return d;
}

function traduzirOrigemRegistro(origem) {
  if (origem === "local" || origem === "Cadastro local") return t("confirm_remove.source_local");
  return t("confirm_remove.source_api");
}

function renderDashboard() {
  if (typeof renderizarCardsAreaPrimaria === "function") {
    renderizarCardsAreaPrimaria(ultimasEtapasAPI);
  }
  if (typeof renderizarBercosResumoFallback === "function" && ultimosBercosAPI.length) {
    renderizarBercosResumoFallback(ultimosBercosAPI);
  } else {
    if (typeof atualizarRitmoBerco101FluxoMecanizado === "function") {
      atualizarRitmoBerco101FluxoMecanizado();
    }
    if (typeof atualizarPranchaExpedicaoFluxo === "function") {
      atualizarPranchaExpedicaoFluxo();
    }
    if (typeof atualizarBotaoFluxoExpedicao === "function") {
      atualizarBotaoFluxoExpedicao();
    }
  }
  if (typeof renderizarListaAlertasDOM === "function") {
    renderizarListaAlertasDOM(alertasAtivosAPI);
  }
  if (typeof atualizarGraficoFluxoOverview === "function") {
    atualizarGraficoFluxoOverview();
  }
}

function aplicarIdiomaUI(lang) {
  const novoIdioma = lang === "en-US" ? "en-US" : "pt-BR";
  idiomaAtual = novoIdioma;
  try {
    localStorage.setItem(STORAGE_KEY_IDIOMA, novoIdioma);
  } catch (e) {
    // ignore storage errors
  }

  document.documentElement.lang = novoIdioma;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) {
      el.textContent = t(key);
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.setAttribute("placeholder", t(key));
  });

  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria");
    if (key) el.setAttribute("aria-label", t(key));
  });

  const langSelect = document.getElementById("language-select");
  if (langSelect && langSelect.value !== novoIdioma) {
    langSelect.value = novoIdioma;
  }

  if (typeof atualizarTituloPaginaAtual === "function") atualizarTituloPaginaAtual();
  if (typeof atualizarRelogioCabecalho === "function") atualizarRelogioCabecalho();
  if (typeof atualizarStatusConexaoUI === "function") atualizarStatusConexaoUI(apiConectada);

  renderDashboard();
  if (typeof renderMovements === "function") renderMovements();
  if (typeof renderCarriers === "function") renderCarriers();
  if (typeof atualizarSubtitulosRelatorios === "function") atualizarSubtitulosRelatorios();
  if (typeof renderizarListaVeiculosLocais === "function") renderizarListaVeiculosLocais();
  if (typeof atualizarBotaoRestaurarRemovidos === "function") atualizarBotaoRestaurarRemovidos();
  if (typeof atualizarNotaResumoConfiguracoes === "function") atualizarNotaResumoConfiguracoes();
}

const STORAGE_KEY_VEICULOS_LOCAIS = "cco_veiculos_cadastrados_localmente";
const STORAGE_KEY_VEICULOS_REMOVIDOS = "cco_veiculos_removidos_sessao";
const STORAGE_KEY_HISTORICO_EXCLUIDOS = "cco_historico_veiculos_excluidos";

function carregarVeiculosLocaisStorage() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY_VEICULOS_LOCAIS) ||
      sessionStorage.getItem(STORAGE_KEY_VEICULOS_LOCAIS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function salvarVeiculosLocaisStorage(lista) {
  try {
    const serializado = JSON.stringify(lista);
    localStorage.setItem(STORAGE_KEY_VEICULOS_LOCAIS, serializado);
    sessionStorage.setItem(STORAGE_KEY_VEICULOS_LOCAIS, serializado);
  } catch (e) {
    console.warn("Não foi possível persistir veículos locais no storage:", e);
  }
}

function carregarVeiculosRemovidosStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_VEICULOS_REMOVIDOS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function salvarVeiculosRemovidosStorage(conjunto) {
  try {
    sessionStorage.setItem(
      STORAGE_KEY_VEICULOS_REMOVIDOS,
      JSON.stringify(Array.from(conjunto))
    );
  } catch (e) {
    console.warn("Não foi possível persistir exclusões da sessão:", e);
  }
}

function carregarHistoricoExcluidosStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_HISTORICO_EXCLUIDOS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function salvarHistoricoExcluidosStorage(lista) {
  try {
    sessionStorage.setItem(
      STORAGE_KEY_HISTORICO_EXCLUIDOS,
      JSON.stringify(lista)
    );
  } catch (e) {
    console.warn("Não foi possível persistir histórico de exclusões:", e);
  }
}

var veiculosCadastradosLocalmente = carregarVeiculosLocaisStorage();
var veiculosRemovidosSessao = new Set(carregarVeiculosRemovidosStorage());
var historicoVeiculosExcluidos = carregarHistoricoExcluidosStorage();

function obterChaveRegistroVeiculo(item) {
  if (!item) return "";
  const idOuTicket = item.id || item.ticket;
  if (idOuTicket) return normalizarTexto(idOuTicket);
  return normalizarTexto(item.plate);
}

const DESTINOS_PADRAO = ["Berço 99", "Berço 101", "Berço 102", "Expedição"];
const ETAPAS_PADRAO = [
  "PAN",
  "Fila PRC",
  "Balança Tara",
  "Operação",
  "Balança Bruto",
  "Gate-out"
];

function escaparHtml(valor) {
  if (valor === null || valor === undefined) return "";
  return String(valor)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizarTexto(texto) {
  if (texto === null || texto === undefined) return "";
  return String(texto)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatarNumero(valor, casasDecimais = 0) {
  const num = Number(valor);
  if (Number.isNaN(num)) return valor ?? "—";
  return num.toLocaleString("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: casasDecimais
  });
}

function normalizarRotuloDestino(valor) {
  if (valor === null || valor === undefined) return "";
  const texto = String(valor).trim();
  if (!texto || texto === "—" || texto === "all") return "";

  const norm = normalizarTexto(texto);
  if (norm.includes("expedicao") || norm.includes("armazem")) {
    return "Expedição";
  }

  // Se for apenas número ("99", "099", "101", "102") ou código de berço ("Berço 99", "BERCO_99", "B099-P1")
  const matchApenasNum = texto.match(/^0*(\d+)$/);
  if (matchApenasNum) {
    return `Berço ${Number(matchApenasNum[1])}`;
  }

  const matchBerco = norm.match(/^(?:berco|b)\s*0*(\d+)/);
  if (matchBerco) {
    return `Berço ${Number(matchBerco[1])}`;
  }

  return texto;
}

function normalizarRotuloEtapa(valor) {
  if (valor === null || valor === undefined) return "";
  const semPrefixo = String(valor)
    .replace(/^\d+\s*[.\-)]\s*/, "")
    .trim();
  if (!semPrefixo || semPrefixo === "—" || semPrefixo === "all") return "";

  const norm = normalizarTexto(semPrefixo);
  if (norm === "pan" || norm.includes("entrada pan") || norm === "triagem") {
    return "PAN";
  }
  if (norm.includes("fila prc") || norm === "prc" || norm === "fila") {
    return "Fila PRC";
  }
  if (norm.includes("patio")) {
    return "Pátio";
  }
  if (norm.includes("balanca tara") || norm.includes("balanca entrada") || norm.includes("pesagem inicial") || norm === "tara") {
    return "Balança Tara";
  }
  if (
    norm === "operacao" ||
    norm.includes("descarga") ||
    norm.includes("carregamento")
  ) {
    return "Operação";
  }
  if (norm.includes("balanca bruto") || norm.includes("balanca saida") || norm === "bruto" || norm.includes("pesagem final")) {
    return "Balança Bruto";
  }
  if (norm.includes("gate out") || norm === "gateout" || norm === "saida") {
    return "Gate-out";
  }

  return semPrefixo;
}

function mesclarVeiculosComLocais(listaBase = []) {
  const baseArray = Array.isArray(listaBase) ? listaBase : [];
  const baseVisivel = baseArray.filter(v => {
    const chave = obterChaveRegistroVeiculo(v);
    const placaNorm = normalizarTexto(v.plate);
    return (
      !veiculosRemovidosSessao.has(chave) &&
      !veiculosRemovidosSessao.has(placaNorm)
    );
  });

  if (!veiculosCadastradosLocalmente.length) {
    return [...baseVisivel];
  }

  const placasLocais = new Set(
    veiculosCadastradosLocalmente.map(v => normalizarTexto(v.plate))
  );
  const restantesDaBase = baseVisivel.filter(
    v => !placasLocais.has(normalizarTexto(v.plate))
  );

  return [...veiculosCadastradosLocalmente, ...restantesDaBase];
}

function coincidirDestino(itemFlow, filtroDestino) {
  if (!filtroDestino || filtroDestino === "all") return true;
  if (!itemFlow || itemFlow === "all") return false;

  const f = normalizarTexto(itemFlow);
  const d = normalizarTexto(filtroDestino);
  if (!f || !d) return false;
  if (f === d || f.includes(d) || d.includes(f)) return true;

  // Compatibilidade entre códigos "B099-P1" / "B99" / "BERCO_99" e "Berço 99"
  const numFiltro = d.match(/\d+/);
  const numItem = f.match(/\d+/);
  if (numFiltro && numItem && Number(numFiltro[0]) === Number(numItem[0])) {
    return true;
  }

  if (
    (d.includes("expedicao") || d.includes("armazem")) &&
    (f.includes("expedicao") || f.includes("armazem"))
  ) {
    return true;
  }

  return false;
}

function coincidirEtapa(itemStage, filtroEtapa) {
  if (!filtroEtapa || filtroEtapa === "all") return true;
  if (!itemStage || itemStage === "all") return false;

  const etapaItem = normalizarRotuloEtapa(itemStage);
  const etapaFiltro = normalizarRotuloEtapa(filtroEtapa);
  if (!etapaItem || !etapaFiltro) return false;

  return normalizarTexto(etapaItem) === normalizarTexto(etapaFiltro);
}

/* -----------------------------------------
   AGRUPAMENTO DA ÁREA PRIMÁRIA (MODAL CONVENCIONAL)
----------------------------------------- */
const ETAPAS_GRUPOS_AREA_PRIMARIA = {
  sem_coletor: ["Fila PRC", "Pátio"],
  coletor_balanca: ["Operação"],
  balanca_pan: ["Balança Tara", "Balança Bruto", "PAN"],
  balanca_apenas: ["Balança Tara", "Balança Bruto"],
  pan_apenas: ["PAN"]
};

function obterEtapasDoGrupoAreaPrimaria(grupo) {
  if (grupo === "total") {
    return [
      ...ETAPAS_GRUPOS_AREA_PRIMARIA.sem_coletor,
      ...ETAPAS_GRUPOS_AREA_PRIMARIA.coletor_balanca,
      ...ETAPAS_GRUPOS_AREA_PRIMARIA.balanca_pan
    ];
  }
  return ETAPAS_GRUPOS_AREA_PRIMARIA[grupo] || [];
}

function pertenceAoGrupoAreaPrimaria(stage, grupo) {
  if (!stage) return false;
  const etapas = obterEtapasDoGrupoAreaPrimaria(grupo);
  if (!etapas.length) return false;
  return etapas.some(etapaAlvo => coincidirEtapa(stage, etapaAlvo));
}

function coincidirOperacao(itemOp, filtroOp) {
  if (!filtroOp || filtroOp === "all") return true;
  const opItem = normalizarTexto(itemOp);
  const opFiltro = normalizarTexto(filtroOp);
  if (!opItem) return false;
  if (opItem === opFiltro || opItem.includes(opFiltro) || opFiltro.includes(opItem)) return true;

  if (opFiltro === "recebimento" && (opItem.includes("descarga") || opItem.includes("importacao"))) {
    return true;
  }
  if (
    opFiltro === "expedicao" &&
    (opItem.includes("carregamento") || opItem.includes("embarque") || opItem.includes("exportacao"))
  ) {
    return true;
  }
  return false;
}

const FUSO_HORARIO_BRASILIA = "America/Sao_Paulo";

function obterHoraBrasiliaFormatada(incluirSegundos = true) {
  const opcoes = {
    timeZone: FUSO_HORARIO_BRASILIA,
    hour: "2-digit",
    minute: "2-digit"
  };
  if (incluirSegundos) {
    opcoes.second = "2-digit";
  }
  return new Date().toLocaleTimeString("pt-BR", opcoes);
}

function atualizarRelogioCabecalho(sufixo = "") {
  const agora = new Date();
  const locale = idiomaAtual === "en-US" ? "en-US" : "pt-BR";
  const elCurrentDate = document.getElementById("current-date");
  if (elCurrentDate) {
    elCurrentDate.textContent = agora.toLocaleDateString(locale, {
      timeZone: FUSO_HORARIO_BRASILIA,
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  }

  const horaStr = obterHoraBrasiliaFormatada(true);
  const elCurrentTime = document.getElementById("current-time");
  const elLastUpdate = document.getElementById("last-update");
  const prefixoAtualizado = idiomaAtual === "en-US" ? "Updated at" : "Atualizado às";
  const textoFinal = sufixo ? `${horaStr} ${sufixo}` : `${prefixoAtualizado} ${horaStr}`;

  if (elCurrentTime) {
    elCurrentTime.textContent = textoFinal;
  }
  if (elLastUpdate) {
    elLastUpdate.textContent = textoFinal;
  }
  return horaStr;
}

function atualizarStatusConexaoUI(online, _timestampTexto) {
  apiConectada = online;

  const seloAoVivo = document.querySelector(".visao-geral__ao-vivo");
  const elHora = document.getElementById("current-time");
  const elLastUpdate = document.getElementById("last-update");
  const etiquetaMovimentacoes = document.getElementById("movement-api-status");
  const observacoes = document.querySelectorAll(".pagina__observacao");
  const rodapeSpans = document.querySelectorAll(".rodape span");

  const agoraFormatado = new Date().toLocaleTimeString(idiomaAtual === "en-US" ? "en-US" : "pt-BR", {
    timeZone: FUSO_HORARIO_BRASILIA,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  if (online) {
    const labelConectado = idiomaAtual === "en-US" ? "Connected to FastAPI" : "Conectado à API FastAPI";
    const prefixoAtualizado = idiomaAtual === "en-US" ? "Updated at" : "Atualizado às";
    if (seloAoVivo) {
      seloAoVivo.innerHTML = `<span class="visao-geral__ponto"></span> ${labelConectado}`;
    }
    if (elHora) {
      elHora.textContent = `${prefixoAtualizado} ${agoraFormatado}`;
    }
    if (elLastUpdate) {
      elLastUpdate.textContent = `${prefixoAtualizado} ${agoraFormatado}`;
    }
    if (etiquetaMovimentacoes) {
      etiquetaMovimentacoes.textContent = labelConectado;
    }
    observacoes.forEach(obs => {
      obs.textContent =
        idiomaAtual === "en-US"
          ? `Real-time data loaded via FastAPI (${API_BASE_URL}).`
          : `Dados carregados em tempo real via API FastAPI (${API_BASE_URL}).`;
    });
    if (rodapeSpans.length >= 2) {
      rodapeSpans[1].textContent =
        idiomaAtual === "en-US"
          ? "Real-time connected — Render API (emap-cco-painel)"
          : "Conectado em tempo real — API Render (emap-cco-painel)";
    }
  } else {
    if (seloAoVivo) {
      seloAoVivo.innerHTML = `<span class="visao-geral__ponto visao-geral__ponto--offline"></span> ${
        idiomaAtual === "en-US" ? "API offline · Sample data" : "API offline · Dados demonstrativos"
      }`;
    }
    if (elHora) {
      elHora.textContent = `${agoraFormatado} · ${idiomaAtual === "en-US" ? "offline mode" : "modo offline"}`;
    }
    if (elLastUpdate) {
      elLastUpdate.textContent = `${agoraFormatado} · ${idiomaAtual === "en-US" ? "offline mode" : "modo offline"}`;
    }
    if (etiquetaMovimentacoes) {
      etiquetaMovimentacoes.textContent =
        idiomaAtual === "en-US" ? "Offline mode (sample data)" : "Modo offline (dados demonstrativos)";
    }
  }
}

/* -----------------------------------------
   UTILITÁRIOS DE DEDUPLICAÇÃO DE ALERTAS
----------------------------------------- */
function extrairIdentificadorVeiculoAlerta(alerta) {
  if (!alerta) return null;
  if (typeof alerta === "string") {
    const partes = alerta.split(" - ");
    if (partes[0] && partes[0].trim()) {
      return partes[0].trim().toUpperCase();
    }
    const match = alerta.match(/[A-Z]{3}-?\d[A-Z0-9]\d{2}/i);
    return match ? match[0].replace("-", "").toUpperCase() : alerta.trim().toUpperCase();
  }
  if (typeof alerta === "object") {
    const id = alerta.ticket ?? alerta.placa ?? alerta.plate ?? alerta.numero_ticket ?? alerta.id;
    if (id) return String(id).trim().toUpperCase();
  }
  return null;
}

function contarVeiculosComAlertaUnicos(listaAlertas) {
  if (!Array.isArray(listaAlertas) || listaAlertas.length === 0) return 0;
  const veiculosUnicos = new Set();
  listaAlertas.forEach(alerta => {
    const id = extrairIdentificadorVeiculoAlerta(alerta);
    if (id) {
      veiculosUnicos.add(id);
    } else {
      veiculosUnicos.add(JSON.stringify(alerta));
    }
  });
  return veiculosUnicos.size;
}

/* -----------------------------------------
   1. GET /dashboard/resumo
----------------------------------------- */
async function carregarResumoDashboard() {
  try {
    const resposta = await fetchComTimeout(`${API_BASE_URL}/dashboard/resumo`);
    if (!resposta.ok) {
      throw new Error(`Erro HTTP ${resposta.status} em /dashboard/resumo`);
    }

    const dados = await resposta.json();
    ultimoResumoAPI = dados;

    const kpiDescarregado = document.getElementById("kpi-descarregado");
    const kpiExpedido = document.getElementById("kpi-expedido");
    const kpiFlow = document.getElementById("kpi-flow");
    const kpiAlertas = document.getElementById("kpi-alertas");

    const labelDescarregado = document.getElementById("kpi-label-descarregado");
    const labelExpedido = document.getElementById("kpi-label-expedido");
    const labelFlow = document.getElementById("kpi-label-flow");
    const labelAlertas = document.getElementById("kpi-label-alertas");

    if (dados.top_executivo) {
      const exec = dados.top_executivo;
      if (kpiDescarregado && exec.total_descarregado_ton !== undefined) {
        kpiDescarregado.innerHTML = `${formatarNumero(exec.total_descarregado_ton, 1)} <small>t</small>`;
      }
      if (kpiExpedido && exec.total_expedido_ton !== undefined) {
        kpiExpedido.innerHTML = `${formatarNumero(exec.total_expedido_ton, 1)} <small>t</small>`;
      }
      if (kpiFlow && exec.veiculos_no_giro !== undefined) {
        const totalAjustado = Math.max(
          0,
          Number(exec.veiculos_no_giro) +
            veiculosCadastradosLocalmente.length -
            historicoVeiculosExcluidos.length
        );
        kpiFlow.textContent = totalAjustado;
      }
      if (labelAlertas) {
        labelAlertas.textContent = idiomaAtual === "en-US" ? "Critical occurrences" : "Ocorrências críticas";
      }
      if (kpiAlertas && (exec.alertas_sobrepeso_ativos !== undefined || dados.alertas_criticos)) {
        let qtdAlertasUnicos = exec.alertas_sobrepeso_ativos ?? 0;
        if (Array.isArray(dados.alertas_criticos) && dados.alertas_criticos.length > 0) {
          qtdAlertasUnicos = contarVeiculosComAlertaUnicos(
            filtrarAlertasNaoResolvidos(dados.alertas_criticos)
          );
        } else if (Array.isArray(alertasAtivosAPI) && alertasAtivosAPI.length > 0) {
          qtdAlertasUnicos = contarVeiculosComAlertaUnicos(
            filtrarAlertasNaoResolvidos(alertasAtivosAPI)
          );
        }
        kpiAlertas.innerHTML = `${qtdAlertasUnicos} <small>${
          idiomaAtual === "en-US" ? "active alerts" : "alertas ativos"
        }</small>`;
      }
    } else {
      const volumeMovimentadoKg =
        dados.volume_total_movimentado_kg ?? dados.volume_descarregado_kg;
      const totalDescarregadoTon = dados.total_descarregado_ton;

      if (kpiDescarregado) {
        if (totalDescarregadoTon !== undefined) {
          if (labelDescarregado) labelDescarregado.textContent = "Total descarregado";
          kpiDescarregado.innerHTML = `${formatarNumero(totalDescarregadoTon, 1)} <small>t</small>`;
        } else if (volumeMovimentadoKg !== undefined) {
          if (labelDescarregado) labelDescarregado.textContent = "Volume movimentado";
          const toneladas = Number(volumeMovimentadoKg) / 1000;
          kpiDescarregado.innerHTML = `${formatarNumero(toneladas, 1)} <small>t</small>`;
        }
      }

      const totalExpedidoTon = dados.total_expedido_ton;
      const volumeManifestadoKg = dados.volume_manifestado_kg;
      const tempoMedioMin =
        dados.tempo_medio_permanencia_geral_min ??
        dados.tempo_medio_permanencia_min ??
        dados.tempo_medio_giro_min;

      if (kpiExpedido) {
        if (totalExpedidoTon !== undefined) {
          if (labelExpedido) labelExpedido.textContent = "Total expedido";
          kpiExpedido.innerHTML = `${formatarNumero(totalExpedidoTon, 1)} <small>t</small>`;
        } else if (volumeManifestadoKg !== undefined) {
          if (labelExpedido) labelExpedido.textContent = "Volume manifestado";
          const toneladas = Number(volumeManifestadoKg) / 1000;
          kpiExpedido.innerHTML = `${formatarNumero(toneladas, 1)} <small>t</small>`;
        } else if (tempoMedioMin !== undefined) {
          if (labelExpedido) labelExpedido.textContent = "Tempo médio de permanência";
          kpiExpedido.innerHTML = `${formatarNumero(tempoMedioMin, 1)} <small>min</small>`;
        }
      }

      const veiculosAtivos =
        dados.total_veiculos_ativos ??
        dados.veiculos_no_giro ??
        dados.veiculos_ativos ??
        dados.total_veiculos;

      if (kpiFlow && veiculosAtivos !== undefined) {
        if (labelFlow) labelFlow.textContent = "Veículos no giro";
        kpiFlow.textContent = Number(veiculosAtivos) + veiculosCadastradosLocalmente.length;
      }

      const totalAlertas =
        dados.total_alertas_ativos ??
        dados.veiculos_com_alerta ??
        dados.alertas_sobrepeso_ativos ??
        dados.total_alertas ??
        dados.ocorrencias_criticas;

      if (kpiAlertas && totalAlertas !== undefined) {
        if (labelAlertas) labelAlertas.textContent = idiomaAtual === "en-US" ? "Critical alerts" : "Alertas críticos";
        let qtdAlertasUnicos = totalAlertas;
        if (Array.isArray(dados.alertas_criticos) && dados.alertas_criticos.length > 0) {
          qtdAlertasUnicos = contarVeiculosComAlertaUnicos(
            filtrarAlertasNaoResolvidos(dados.alertas_criticos)
          );
        } else if (Array.isArray(alertasAtivosAPI) && alertasAtivosAPI.length > 0) {
          qtdAlertasUnicos = contarVeiculosComAlertaUnicos(
            filtrarAlertasNaoResolvidos(alertasAtivosAPI)
          );
        }
        kpiAlertas.innerHTML = `${qtdAlertasUnicos} <small>${
          idiomaAtual === "en-US" ? "active alerts" : "alertas ativos"
        }</small>`;
      }
    }

    if (Array.isArray(dados.pontos_operacionais)) {
      renderizarBercosResumoFallback(dados.pontos_operacionais);
    }

    if (!etapasCarregadasPorEndpoint && dados.esteira_etapas) {
      renderizarEtapasResumoFallback(dados.esteira_etapas);
    }

    if (!alertasCarregadosPorEndpoint && Array.isArray(dados.alertas_criticos)) {
      renderizarAlertasResumoFallback(dados.alertas_criticos);
    }

    atualizarStatusConexaoUI(true, dados.timestamp);
    return true;
  } catch (erro) {
    console.warn("⚠️ [API] Não foi possível carregar /dashboard/resumo:", erro.message);
    return false;
  }
}

/* -----------------------------------------
   2. GET /veiculos (?destino= & ?etapa=)
----------------------------------------- */
function converterPesoParaNumero(valor) {
  if (valor === null || valor === undefined || valor === "" || valor === "—") return null;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  const texto = String(valor).trim().replace(/\s*kg$/i, "");
  if (!texto) return null;
  // Formato pt-BR com separador de milhar (ex.: "50.300" ou "50.300,5")
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(texto)) {
    const n = Number(texto.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(texto.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function buscarAlertaPorPlaca(placa) {
  const placaNorm = normalizarTexto(placa);
  if (!placaNorm || !Array.isArray(alertasAtivosAPI) || !alertasAtivosAPI.length) {
    return null;
  }
  return (
    alertasAtivosAPI.find(a => {
      if (!a || typeof a !== "object") return false;
      return normalizarTexto(a.placa ?? a.plate) === placaNorm;
    }) || null
  );
}

const LIMIARES_ATENCAO_SLA_MIN = {
  "Fila PRC": 96,
  "Operação": 72,
  "PAN": 48,
  "Balança Tara": 36,
  "Balança Bruto": 24
};

function resolverAlertaVeiculo(item) {
  const limiteSobrepeso = Number(configOperacionalCCO?.limiteSobrepesoKg) || 48500;
  const limiteRetencaoPrc = Number(configOperacionalCCO?.limiteRetencaoPrcMin) || 120;

  const placa = item?.plate ?? item?.placa ?? "";
  const alertaMatch = buscarAlertaPorPlaca(placa);
  const etapaCanon = normalizarRotuloEtapa(item?.stage ?? item?.etapa ?? "");
  const tempoMin = Number(item?.durationMin ?? item?.tempo_permanencia ?? 0);
  const pesoBrutoItem = converterPesoParaNumero(
    item?.grossWeight ??
      item?.peso_bruto_kg ??
      item?.peso_bruto ??
      item?.peso_cheio ??
      item?.PesoCheio
  );
  const pesoNum =
    pesoBrutoItem ??
    item?.pesoNumerico ??
    converterPesoParaNumero(
      item?.peso_kg ??
        item?.peso_liquido ??
        item?.PesoLiquido ??
        item?.peso ??
        item?.netWeight
    );

  const tipoAnomalia = String(
    alertaMatch?.tipo_anomalia ?? alertaMatch?.tipo_alerta ?? item?.tipo_alerta ?? ""
  ).toUpperCase();

  const excessoInformado =
    alertaMatch?.excesso_peso_kg ?? item?.excesso_peso_kg ?? item?.excesso_peso ?? null;
  const pesoRealEstimado = item?._pesoEditadoManualmente
    ? pesoNum
    : pesoNum !== null && pesoNum > 35000
    ? pesoNum
    : excessoInformado !== null && Number(excessoInformado) > 0
    ? 48500 + Number(excessoInformado)
    : pesoNum;

  const ehSobrepeso = item?._pesoEditadoManualmente
    ? pesoRealEstimado !== null && pesoRealEstimado > limiteSobrepeso
    : (pesoRealEstimado !== null && pesoRealEstimado > limiteSobrepeso) ||
      ((tipoAnomalia.includes("SOBREPESO") ||
        item?.sobrepeso === true ||
        normalizarTexto(item?.overweight).includes("sim")) &&
        (pesoRealEstimado === null || pesoRealEstimado > limiteSobrepeso));

  const badges = [];
  let excessoKgCalculado = null;

  if (ehSobrepeso) {
    excessoKgCalculado =
      pesoRealEstimado !== null && pesoRealEstimado > limiteSobrepeso
        ? pesoRealEstimado - limiteSobrepeso
        : excessoInformado !== null && Number(excessoInformado) > 0
        ? Number(excessoInformado)
        : null;
    const labelSobrepeso = idiomaAtual === "en-US" ? "Overweight" : "Sobrepeso";
    const rotulo =
      excessoKgCalculado !== null && excessoKgCalculado > 0
        ? `${labelSobrepeso} (+${formatarNumero(excessoKgCalculado, 0)} kg)`
        : labelSobrepeso;
    badges.push({
      tipo: "SOBREPESO",
      rotulo,
      classeBadge: "badge badge--critico",
      nivel: "critico"
    });
  }

  const minsPrc = item?._tempoEditadoManualmente
    ? tempoMin
    : Number(alertaMatch?.tempo_permanencia ?? tempoMin) || 0;
  const ehRetencaoPrc = item?._tempoEditadoManualmente
    ? etapaCanon === "Fila PRC" && minsPrc > limiteRetencaoPrc
    : (etapaCanon === "Fila PRC" && minsPrc > limiteRetencaoPrc) ||
      ((tipoAnomalia.includes("PRC") || tipoAnomalia.includes("RETENCAO")) &&
        (minsPrc === 0 || minsPrc > limiteRetencaoPrc));

  if (ehRetencaoPrc) {
    const labelPrc = idiomaAtual === "en-US" ? "PRC Retention" : "Retenção PRC";
    const rotulo = minsPrc > 0 ? `${labelPrc} (${formatarNumero(minsPrc, 0)} min)` : labelPrc;
    badges.push({
      tipo: "RETENCAO_PRC",
      rotulo,
      classeBadge: "badge badge--critico",
      nivel: "critico"
    });
  }

  if (
    !badges.length &&
    !tipoAnomalia.includes("SOBREPESO") &&
    !tipoAnomalia.includes("PRC") &&
    !tipoAnomalia.includes("RETENCAO") &&
    (alertaMatch || item?.possui_alerta === true || item?.status === "Parado")
  ) {
    const rotulo =
      alertaMatch?.tipo_anomalia ||
      alertaMatch?.tipo_alerta ||
      item?.tipo_alerta ||
      (item?.status && item.status !== "Em operação" && item.status !== "Finalizado"
        ? traduzirSituacao(item.status)
        : idiomaAtual === "en-US"
        ? "In Alert"
        : "Em Alerta");
    badges.push({
      tipo: "ALERTA",
      rotulo,
      classeBadge: "badge badge--critico",
      nivel: "critico"
    });
  }

  const placaNorm = normalizarTexto(placa);
  const badgesVisiveis = badges.filter(b => {
    if (b.nivel !== "critico" || !placaNorm) return true;
    const chaveBadge = `${b.tipo}::${placaNorm}`;
    if (alertasResolvidosLocal.has(chaveBadge)) return false;
    if (b.tipo === "ALERTA" && alertasResolvidosLocal.has(`${normalizarTexto(b.rotulo)}::${placaNorm}`)) {
      return false;
    }
    return true;
  });

  const possuiCritico = badgesVisiveis.some(b => b.nivel === "critico");
  if (!possuiCritico) {
    const limiarAtencao =
      etapaCanon === "Fila PRC"
        ? Math.round(limiteRetencaoPrc * 0.8)
        : LIMIARES_ATENCAO_SLA_MIN[etapaCanon];
    if (limiarAtencao !== undefined && tempoMin >= limiarAtencao) {
      const labelSla = idiomaAtual === "en-US" ? "SLA Warning" : "Atenção SLA";
      badgesVisiveis.push({
        tipo: "ATENCAO_SLA",
        rotulo: `${labelSla} (${formatarNumero(tempoMin, 0)} min)`,
        classeBadge: "badge badge--atencao",
        nivel: "atencao"
      });
    }
  }

  const principal = badgesVisiveis[0] || null;
  return {
    temAlerta: possuiCritico,
    temAtencao: badgesVisiveis.some(b => b.nivel === "atencao"),
    tipo: principal ? principal.tipo : null,
    rotulo: principal ? principal.rotulo : item?.status || "Em operação",
    classeBadge: principal ? principal.classeBadge : "",
    excessoKg: excessoKgCalculado,
    badges: badgesVisiveis
  };
}

function mapearVeiculoDaAPI(v) {
  const pesoTaraRaw = v.peso_tara_kg ?? v.peso_tara ?? v.tareWeight ?? null;
  const pesoBrutoRaw =
    v.peso_bruto_kg ??
    v.peso_bruto ??
    v.peso_cheio ??
    v.PesoCheio ??
    v.peso_movimentado ??
    v.PesoMovimentado ??
    v.grossWeight ??
    null;
  const pesoLiquidoRaw =
    v.peso_liquido_kg ??
    v.peso_liquido ??
    v.PesoLiquido ??
    v.peso_kg ??
    v.peso ??
    v.volume_carga_kg ??
    v.peso_manifestado_kg ??
    v.PesoManifestadoKg ??
    v.netWeight ??
    (pesoBrutoRaw !== null && pesoTaraRaw !== null
      ? Number(pesoBrutoRaw) - Number(pesoTaraRaw)
      : null);

  const pesoTaraNum = converterPesoParaNumero(pesoTaraRaw);
  const pesoBrutoNum = converterPesoParaNumero(pesoBrutoRaw);
  const pesoLiquidoNum = converterPesoParaNumero(pesoLiquidoRaw);
  const pesoNumerico = pesoLiquidoNum ?? pesoBrutoNum ?? pesoTaraNum ?? null;

  const tempoPermanenciaNum =
    v.tempo_permanencia_min !== undefined && v.tempo_permanencia_min !== null
      ? Number(v.tempo_permanencia_min)
      : v.tempo_permanencia !== undefined && v.tempo_permanencia !== null
      ? Number(v.tempo_permanencia)
      : null;

  const tempoPermanencia =
    tempoPermanenciaNum !== null && !Number.isNaN(tempoPermanenciaNum)
      ? `${formatarNumero(tempoPermanenciaNum, 0)} min`
      : v.duracao ?? v.duration ?? "—";

  const etapaBruta = v.etapa_atual ?? v.etapa ?? v.stage ?? "—";
  const destinoBruto = v.berco_destino ?? v.destino ?? v.fluxo ?? v.flow ?? "—";

  const etapa = normalizarRotuloEtapa(etapaBruta) || "—";
  const destino = normalizarRotuloDestino(destinoBruto) || "—";

  let operacao =
    v.tipo_operacao ??
    v.operacao ??
    v.operation ??
    (normalizarTexto(v.TipoMovimentacao ?? v.tipo_movimentacao) === "saida"
      ? "Expedição"
      : normalizarTexto(v.TipoMovimentacao ?? v.tipo_movimentacao) === "entrada"
      ? "Recebimento"
      : null);
  if (!operacao) {
    operacao =
      normalizarTexto(destino).includes("expedicao") || normalizarTexto(destino).includes("armazem")
        ? "Expedição"
        : "Recebimento";
  }

  const placa = v.placa ?? v.Placa ?? v.plate ?? "—";
  const alertaInfo = resolverAlertaVeiculo({
    plate: placa,
    stage: etapa,
    durationMin: tempoPermanenciaNum ?? extrairMinutosDeTexto(tempoPermanencia),
    pesoNumerico,
    sobrepeso: v.sobrepeso,
    excesso_peso: v.excesso_peso,
    excesso_peso_kg: v.excesso_peso_kg,
    possui_alerta: v.possui_alerta === true || v.status === "Parado" || v.status_operacional === "CRITICO",
    tipo_alerta: v.tipo_alerta ?? v.tipo_anomalia ?? null,
    status: v.situacao ?? v.status
  });

  const possuiAlerta = alertaInfo.temAlerta;

  let sobrepesoTexto = v.sobrepeso ?? v.overweight;
  if (typeof sobrepesoTexto === "boolean") {
    sobrepesoTexto = sobrepesoTexto ? "Sim" : "Não";
  }
  if (!sobrepesoTexto) {
    if (alertaInfo.tipo === "SOBREPESO") {
      sobrepesoTexto = "Sim";
    } else if (possuiAlerta) {
      sobrepesoTexto = v.tipo_alerta ? String(v.tipo_alerta) : "Alerta";
    } else {
      sobrepesoTexto = "Não";
    }
  }

  const situacaoBrutaNorm = normalizarTexto(v.situacao ?? v.status);
  const situacao =
    normalizarRotuloEtapa(etapa) === "Gate-out" ||
    v.status_operacional === "CONCLUIDO" ||
    situacaoBrutaNorm === "finalizado" ||
    situacaoBrutaNorm === "concluido"
      ? "Finalizado"
      : "Em operação";

  // Campos oficiais do contrato iPort (COPI001)
  const unidadeBruta =
    v.unidade ?? v.NomeEmpresa ?? v.nome_empresa ?? v.empresa ?? "COPISI";
  const unidade = String(unidadeBruta || "COPISI").trim().toUpperCase();

  const ticket =
    v.Ticket ?? v.ticket ?? v.numero_ticket ?? v.id_ticket ?? "—";
  const statusTicketRaw =
    v.Status ?? v.status_ticket ?? v.statusTicket ?? "1 - Ativo";
  const statusTicket =
    String(statusTicketRaw) === "1"
      ? "1 - Ativo"
      : String(statusTicketRaw) === "2"
      ? "2 - Alterado"
      : String(statusTicketRaw || "1 - Ativo");

  const tipoMovimentacao =
    v.TipoMovimentacao ??
    v.tipo_movimentacao ??
    v.tipoMovimentacao ??
    (coincidirOperacao(operacao, "Expedição") ? "Saída" : "Entrada");

  const motorista =
    v.NomeMotorista ?? v.nome_motorista ?? v.motorista ?? v.driver ?? "—";
  const transportadora =
    v.NomeTransportadora ??
    v.nome_transportadora ??
    v.transportadora ??
    v.carrier ??
    "Transporte Alfa";
  const cliente =
    v.NomeCliente ?? v.nome_cliente ?? v.cliente ?? v.client ?? "—";
  const referencia =
    v.Referencia ?? v.referencia ?? v.navio ?? v.ship ?? "—";

  const tipoDocumentoLote =
    v.TipoDocumentoLote ?? v.tipo_documento_lote ?? v.tipoDocumentoLote ?? "";
  const numeroDocumentoLote =
    v.NumeroDocumentoLote ??
    v.numero_documento_lote ??
    v.numeroDocumentoLote ??
    v.bl ??
    v.conhecimento_embarque ??
    "—";

  const localFisico =
    v.Local ?? v.local_fisico ?? v.local ?? v.localFisico ?? destino;
  const dataMovimentacao =
    v.DataMovimentacao ??
    v.data_movimentacao ??
    v.dataMovimentacao ??
    v.entrada_pan ??
    v.horario_entrada ??
    v.data_entrada ??
    v.entryPAN ??
    "—";
  const pesoMovimentadoNum = converterPesoParaNumero(
    v.PesoMovimentado ?? v.peso_movimentado ?? v.peso_movimentado_kg ?? pesoNumerico
  );

  return {
    plate: placa,
    Placa: placa,
    ticket,
    Ticket: ticket,
    statusTicket,
    Status: statusTicket,
    unidade,
    NomeEmpresa: unidade,
    tipoMovimentacao,
    TipoMovimentacao: tipoMovimentacao,
    ship: v.navio ?? v.ship ?? (referencia !== "—" ? referencia : "PRESTIGE DIVA"),
    flow: destino,
    window: v.janela ?? v.window ?? "—",
    bl: numeroDocumentoLote,
    driver: motorista,
    NomeMotorista: motorista,
    carrier: transportadora,
    NomeTransportadora: transportadora,
    cliente,
    NomeCliente: cliente,
    referencia,
    Referencia: referencia,
    tipoDocumentoLote,
    TipoDocumentoLote: tipoDocumentoLote,
    numeroDocumentoLote,
    NumeroDocumentoLote: numeroDocumentoLote,
    localFisico,
    Local: localFisico,
    dataMovimentacao,
    DataMovimentacao: dataMovimentacao,
    pesoMovimentadoKg: pesoMovimentadoNum,
    PesoMovimentado: pesoMovimentadoNum,
    pesoManifestadoKg: converterPesoParaNumero(v.PesoManifestadoKg ?? v.peso_manifestado_kg ?? v.pesoManifestadoKg),
    PesoManifestadoKg: converterPesoParaNumero(v.PesoManifestadoKg ?? v.peso_manifestado_kg ?? v.pesoManifestadoKg),
    operation: operacao,
    entry: v.horario_entrada ?? v.entry ?? "—",
    entryPAN: dataMovimentacao,
    axles: v.eixos ?? v.axles ?? 6,
    tareWeight: pesoTaraNum !== null ? formatarNumero(pesoTaraNum) : null,
    tareDate: v.data_tara ?? v.horario_tara ?? v.tareDate ?? "—",
    collectorDate: v.data_coletor ?? v.horario_operacao ?? v.collectorDate ?? "—",
    grossWeight: pesoBrutoNum !== null ? formatarNumero(pesoBrutoNum) : null,
    netWeight: pesoLiquidoNum !== null ? formatarNumero(pesoLiquidoNum) : null,
    pesoNumerico,
    grossDate: v.data_cheio ?? v.data_bruto ?? v.horario_bruto ?? v.grossDate ?? "—",
    overweight: sobrepesoTexto,
    exit: v.saida ?? v.horario_saida ?? v.exit ?? "—",
    duration: tempoPermanencia,
    durationMin: tempoPermanenciaNum ?? extrairMinutosDeTexto(tempoPermanencia),
    stage: etapa,
    status: situacao,
    possui_alerta: Boolean(possuiAlerta),
    tipo_alerta: v.tipo_alerta ?? v.tipo_anomalia ?? null,
    sobrepeso: v.sobrepeso === true || alertaInfo.tipo === "SOBREPESO",
    excesso_peso_kg: alertaInfo.excessoKg ?? v.excesso_peso_kg ?? v.excesso_peso ?? null
  };
}

function extrairMinutosDeTexto(texto) {
  if (!texto) return 45;
  const str = String(texto);
  const horasMatch = str.match(/(\d+)\s*h/i);
  const minMatch = str.match(/(\d+)\s*min/i);
  let total = 0;
  if (horasMatch) total += Number(horasMatch[1]) * 60;
  if (minMatch) total += Number(minMatch[1]);
  if (total > 0) return total;
  const apenasNum = str.match(/(\d+)/);
  return apenasNum ? Number(apenasNum[1]) : 45;
}

function atualizarOpcoesSelect(selectId, valores, rotuloPadrao, valoresFixos = []) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const valorAtual = select.value;
  const mapaUnicos = new Map();

  [...valoresFixos, ...valores].forEach(val => {
    if (!val || val === "—" || val === "all") return;

    let rotuloFormatado = String(val).trim();
    if (selectId === "movement-destino") {
      rotuloFormatado = normalizarRotuloDestino(rotuloFormatado);
    } else if (selectId === "movement-etapa") {
      rotuloFormatado = normalizarRotuloEtapa(rotuloFormatado);
    }

    if (!rotuloFormatado || rotuloFormatado === "—") return;

    const chave = normalizarTexto(rotuloFormatado).replace(/^\d+\s*[.\-)]\s*/, "");
    if (chave && !mapaUnicos.has(chave)) {
      mapaUnicos.set(chave, rotuloFormatado);
    }
  });

  const unicos = Array.from(mapaUnicos.values());
  if (!unicos.length) return;

  select.innerHTML = [
    `<option value="all">${escaparHtml(rotuloPadrao)}</option>`,
    ...unicos.map(val => `<option value="${escaparHtml(val)}">${escaparHtml(val)}</option>`)
  ].join("");

  if (valorAtual && valorAtual !== "all") {
    selecionarOpcaoEquivalente(select, valorAtual);
  } else {
    select.value = "all";
  }
}

async function carregarVeiculos(filtros = {}) {
  const selectDestino = document.getElementById("movement-destino");
  const selectEtapa = document.getElementById("movement-etapa");

  const destino =
    filtros.destino !== undefined
      ? filtros.destino
      : selectDestino
      ? selectDestino.value
      : "all";

  const etapa =
    filtros.etapa !== undefined
      ? filtros.etapa
      : selectEtapa
      ? selectEtapa.value
      : "all";

  const params = new URLSearchParams();
  if (destino && destino !== "all") {
    params.set("destino", destino);
  }
  if (etapa && etapa !== "all") {
    params.set("etapa", etapa);
  }

  const queryString = params.toString();
  const url = `${API_BASE_URL}/veiculos${queryString ? `?${queryString}` : ""}`;

  try {
    const resposta = await fetchComTimeout(url);
    if (!resposta.ok) {
      throw new Error(`Erro HTTP ${resposta.status} em /veiculos`);
    }

    const dados = await resposta.json();
    const listaBruta = Array.isArray(dados)
      ? dados
      : dados.veiculos || dados.items || dados.data || [];

    const mapeados = listaBruta.map(mapearVeiculoDaAPI);

    if ((!destino || destino === "all") && (!etapa || etapa === "all")) {
      const mesclados = mesclarVeiculosComLocais(mapeados);
      cacheTodosVeiculosAPI = mesclados;
      veiculosAtivosAPI = mesclados;

      if (mesclados.length > 0) {
        atualizarOpcoesSelect(
          "movement-carrier",
          mesclados.map(v => v.carrier),
          "Todas",
          ["Transporte Alfa", "Translog", "Veloz Cargas", "Rota Sul", "Logística Brasil"]
        );
        atualizarOpcoesSelect(
          "movement-destino",
          mesclados.map(v => v.flow),
          "Todos",
          DESTINOS_PADRAO
        );
        atualizarOpcoesSelect(
          "movement-etapa",
          mesclados.map(v => v.stage),
          "Todas",
          ETAPAS_PADRAO
        );
      }
    } else {
      if (mapeados.length > 0) {
        veiculosAtivosAPI = mesclarVeiculosComLocais(mapeados);
      } else if (Array.isArray(cacheTodosVeiculosAPI) && cacheTodosVeiculosAPI.length > 0) {
        veiculosAtivosAPI = mesclarVeiculosComLocais(cacheTodosVeiculosAPI);
      } else {
        veiculosAtivosAPI = mesclarVeiculosComLocais([]);
      }
    }

    renderMovements(true);
    if (typeof atualizarBadgesFluxoConvencional === "function") {
      atualizarBadgesFluxoConvencional();
    }
    if (typeof atualizarBotaoFluxoExpedicao === "function") {
      atualizarBotaoFluxoExpedicao();
    }
    atualizarPainelTransportadorasOverview();
    if (typeof atualizarGraficoFluxoOverview === "function") {
      atualizarGraficoFluxoOverview();
    }
    renderCarriers();
    atualizarSubtitulosRelatorios();
    return true;
  } catch (erro) {
    console.warn("⚠️ [API] Não foi possível carregar /veiculos:", erro.message);
    renderMovements(false);
    if (typeof atualizarBadgesFluxoConvencional === "function") {
      atualizarBadgesFluxoConvencional();
    }
    if (typeof atualizarBotaoFluxoExpedicao === "function") {
      atualizarBotaoFluxoExpedicao();
    }
    atualizarPainelTransportadorasOverview();
    if (typeof atualizarGraficoFluxoOverview === "function") {
      atualizarGraficoFluxoOverview();
    }
    renderCarriers();
    atualizarSubtitulosRelatorios();
    return false;
  }
}

/* -----------------------------------------
   3. GET /veiculos/alertas
----------------------------------------- */
async function carregarAlertasVeiculos() {
  try {
    const resposta = await fetchComTimeout(`${API_BASE_URL}/veiculos/alertas`);
    if (!resposta.ok) {
      throw new Error(`Erro HTTP ${resposta.status} em /veiculos/alertas`);
    }

    const dados = await resposta.json();
    const listaAlertas = Array.isArray(dados)
      ? dados
      : dados.alertas || dados.items || dados.veiculos || dados.data || [];

    alertasAtivosAPI = listaAlertas;
    alertasCarregadosPorEndpoint = true;
    renderizarListaAlertasDOM(listaAlertas);
    if (Array.isArray(veiculosAtivosAPI) || Array.isArray(cacheTodosVeiculosAPI)) {
      renderMovements();
    }
    return true;
  } catch (erro) {
    console.warn("⚠️ [API] Não foi possível carregar /veiculos/alertas:", erro.message);
    return false;
  }
}

function renderizarListaAlertasDOM(listaAlertas) {
  const listaBruta = Array.isArray(listaAlertas) ? listaAlertas : [];
  ultimosAlertasBrutos = listaBruta;
  const lista = filtrarAlertasNaoResolvidos(listaBruta);
  const containerLista = document.querySelector(".alertas__lista");
  const contadorAlertas = document.querySelector(".alertas__contador");
  const kpiAlertas = document.getElementById("kpi-alertas");

  mapaAlertasRenderizados.clear();
  atualizarBotaoRestaurarAlertas();

  const qtdVeiculosUnicos = contarVeiculosComAlertaUnicos(lista);

  if (contadorAlertas) {
    contadorAlertas.textContent =
      idiomaAtual === "en-US"
        ? `${lista.length} active`
        : `${lista.length} ativo${lista.length === 1 ? "" : "s"}`;
  }

  if (kpiAlertas) {
    kpiAlertas.innerHTML = `${qtdVeiculosUnicos} <small>${
      idiomaAtual === "en-US" ? "active alerts" : "alertas ativos"
    }</small>`;
  }

  if (!containerLista) return;

  if (lista.length === 0) {
    containerLista.innerHTML = `
      <div class="alertas__item alertas__item--normal">
        <span class="alertas__icone">✓</span>
        <div class="alertas__conteudo">
          <strong>${idiomaAtual === "en-US" ? "Operation without critical alerts" : "Operação sem alertas críticos"}</strong>
          <p>${
            idiomaAtual === "en-US"
              ? "No active operational alerts at the moment."
              : "Nenhum alerta operacional ativo no momento."
          }</p>
        </div>
      </div>
    `;
    return;
  }

  const labelResolver = idiomaAtual === "en-US" ? "Resolve" : "Resolver";

  containerLista.innerHTML = lista
    .map(alerta => {
      const chaveAlerta = obterChaveUnicaAlerta(alerta);

      if (typeof alerta === "string") {
        const ehSobrepeso = alerta.toUpperCase().includes("SOBREPESO");
        const tipoTexto = ehSobrepeso
          ? idiomaAtual === "en-US"
            ? "Overweight Detected"
            : "Sobrepeso Detectado"
          : idiomaAtual === "en-US"
          ? "Operational / Queue Deviation"
          : "Desvio Operacional / Fila";
        const edicaoSalva = alertasEditadosLocal[chaveAlerta] || null;
        const valorExibido = edicaoSalva?.valorAtual || alerta;
        const badgeEditadoHtml = edicaoSalva
          ? `<span class="alertas__editado-badge">${idiomaAtual === "en-US" ? "Edited" : "Editado"}</span>`
          : "";
        const resumoEditadoTexto =
          edicaoSalva && Array.isArray(edicaoSalva.alteracoes) && edicaoSalva.alteracoes.length
            ? `${idiomaAtual === "en-US" ? "Edited" : "Editado"} · ${edicaoSalva.alteracoes.join(" · ")}`
            : "";
        const resumoEditadoHtml = resumoEditadoTexto
          ? `<p class="alertas__edicao-resumo">${escaparHtml(resumoEditadoTexto)}</p>`
          : "";
        mapaAlertasRenderizados.set(chaveAlerta, {
          chave: chaveAlerta,
          tipo: tipoTexto,
          placa: "—",
          etapa: edicaoSalva?.etapa || "—",
          valorAtual: valorExibido,
          limite: "—",
          original: {
            etapa: "—",
            valorAtual: alerta
          },
          edicao: edicaoSalva
        });
        return `
          <div class="alertas__item alertas__item--critico">
            <span class="alertas__icone">!</span>
            <div class="alertas__conteudo">
              <strong>${escaparHtml(tipoTexto)}</strong>
              <p>${escaparHtml(valorExibido)}</p>
              ${resumoEditadoHtml}
            </div>
            <div class="alertas__acoes">
              ${badgeEditadoHtml}
              <span class="alertas__nivel">${escaparHtml(t("alerts.badge_critical"))}</span>
              <button type="button" class="alertas__resolver-btn" data-action="resolve-alert" data-alert-key="${escaparHtml(chaveAlerta)}">${escaparHtml(labelResolver)}</button>
            </div>
          </div>
        `;
      }

      const placa = alerta.placa ?? alerta.plate ?? "—";
      const tipoRaw = String(alerta.tipo_anomalia ?? alerta.tipo_alerta ?? "").toUpperCase();
      const excessoKg = Number(alerta.excesso_peso_kg ?? alerta.excesso_peso ?? 0);
      const ehSobrepeso = tipoRaw.includes("SOBREPESO") || excessoKg > 0;
      const ehRetencao = tipoRaw.includes("PRC") || tipoRaw.includes("RETENCAO");

      const placaNorm = normalizarTexto(placa);
      const veiculoRel = (
        typeof obterFonteVeiculosCompleta === "function"
          ? obterFonteVeiculosCompleta()
          : (cacheTodosVeiculosAPI || veiculosAtivosAPI || [])
      ).find(v => normalizarTexto(v.plate) === placaNorm);

      const etapaBruta =
        alerta.etapa_atual ??
        alerta.etapa ??
        veiculoRel?.stage ??
        (ehSobrepeso ? "Balança Bruto" : ehRetencao ? "Fila PRC" : "—");

      const itemParaExibicao = {
        ...(veiculoRel || {}),
        flow:
          alerta.flow ??
          alerta.destino ??
          alerta.berco ??
          alerta.berco_destino ??
          veiculoRel?.flow ??
          veiculoRel?.destino ??
          "",
        operation:
          alerta.operacao ??
          alerta.operation ??
          veiculoRel?.operation ??
          veiculoRel?.operacao ??
          "",
        stage: etapaBruta
      };

      const rotuloRetencao = formatarRotuloAlertaParaExibicao(itemParaExibicao, {
        rotulo: "Retenção PRC",
        tipo: "RETENCAO_PRC"
      });

      let tituloTipo = alerta.tipo_anomalia ?? alerta.tipo_alerta ?? "ALERTA OPERACIONAL";
      if (ehSobrepeso) {
        tituloTipo = "EXCESSO DE PESO NA BALANÇA";
      } else if (ehRetencao) {
        tituloTipo =
          rotuloRetencao === "Retenção Gate in"
            ? "RETENÇÃO GATE IN"
            : "RETENÇÃO NO PÁTIO PRC";
      }

      const etapaAtual =
        (etapaBruta && etapaBruta !== "—"
          ? formatarRotuloEtapaParaExibicao(itemParaExibicao)
          : "") ||
        normalizarRotuloEtapa(etapaBruta) ||
        etapaBruta ||
        "—";

      let valorAtualTexto = "—";
      let limiteTexto = "—";
      let resumoAlerta = tituloTipo;

      if (ehSobrepeso) {
        const limiteConfigSobrepeso = Number(configOperacionalCCO?.limiteSobrepesoKg) || 48500;
        const pesoAtual =
          alerta.valor_atual ??
          alerta.peso_bruto_kg ??
          alerta.peso_kg ??
          (excessoKg > 0 ? 48500 + excessoKg : null);
        const limite = alerta.limite_permitido ?? limiteConfigSobrepeso;
        const excessoDinamico =
          typeof pesoAtual === "number" && pesoAtual > limiteConfigSobrepeso
            ? pesoAtual - limiteConfigSobrepeso
            : excessoKg;
        valorAtualTexto =
          typeof pesoAtual === "number"
            ? `${formatarNumero(pesoAtual, 0)} kg`
            : String(pesoAtual ?? "—");
        const limiteBase =
          typeof limite === "number" ? `${formatarNumero(limite, 0)} kg` : String(limite);
        limiteTexto =
          excessoDinamico > 0
            ? `${limiteBase} · +${formatarNumero(excessoDinamico, 0)} kg`
            : limiteBase;
        resumoAlerta =
          excessoDinamico > 0
            ? `Sobrepeso (+${formatarNumero(excessoDinamico, 0)} kg)`
            : `Sobrepeso (${valorAtualTexto})`;
      } else if (ehRetencao) {
        const limiteConfigPrc = Number(configOperacionalCCO?.limiteRetencaoPrcMin) || 120;
        const tempoMin =
          alerta.valor_atual ?? alerta.tempo_permanencia ?? alerta.tempo_permanencia_min ?? null;
        const limiteMin = alerta.limite_permitido ?? limiteConfigPrc;
        valorAtualTexto =
          typeof tempoMin === "number"
            ? `${formatarNumero(tempoMin, 0)} min`
            : String(tempoMin ?? "—");
        limiteTexto =
          typeof limiteMin === "number"
            ? `${formatarNumero(limiteMin, 0)} min`
            : String(limiteMin);
        resumoAlerta =
          tempoMin !== null ? `${rotuloRetencao} (${valorAtualTexto})` : rotuloRetencao;
      } else {
        valorAtualTexto = alerta.valor_atual ?? "—";
        limiteTexto = alerta.limite_permitido ?? "—";
      }

      const edicaoSalva = alertasEditadosLocal[chaveAlerta] || null;
      const etapaOriginal = etapaAtual;
      const valorOriginal = valorAtualTexto;
      const limiteOriginal = limiteTexto;

      const etapaBrutaExibida = edicaoSalva?.etapa || etapaOriginal;
      const etapaExibida =
        edicaoSalva?.etapa && etapaBrutaExibida !== "—"
          ? formatarRotuloEtapaParaExibicao({ ...itemParaExibicao, stage: etapaBrutaExibida }) ||
            etapaBrutaExibida
          : etapaOriginal;

      let valorExibido = edicaoSalva?.valorAtual || valorOriginal;
      let limiteExibido = edicaoSalva?.limite || limiteOriginal;
      let resumoAlertaFinal = resumoAlerta;
      let alteracoesNormalizadas = Array.isArray(edicaoSalva?.alteracoes)
        ? [...edicaoSalva.alteracoes]
        : [];

      if (edicaoSalva?.valorAtual) {
        if (ehSobrepeso || /\bkg\b/i.test(edicaoSalva.valorAtual)) {
          const pesoEditNum = converterPesoParaNumero(edicaoSalva.valorAtual);
          if (pesoEditNum !== null) {
            valorExibido = `${formatarNumero(pesoEditNum, 0)} kg`;
            const limiteConfigSobrepeso = Number(configOperacionalCCO?.limiteSobrepesoKg) || 48500;
            const limiteBaseNum =
              converterPesoParaNumero(String(limiteOriginal).split("·")[0]) ||
              limiteConfigSobrepeso;
            const limiteBaseTexto = `${formatarNumero(limiteBaseNum, 0)} kg`;
            const excessoNovo = pesoEditNum - limiteBaseNum;
            limiteExibido =
              excessoNovo > 0
                ? `${limiteBaseTexto} · +${formatarNumero(excessoNovo, 0)} kg`
                : limiteBaseTexto;
            resumoAlertaFinal =
              excessoNovo > 0
                ? `Sobrepeso (+${formatarNumero(excessoNovo, 0)} kg)`
                : `Sobrepeso (${valorExibido})`;
            if (valorExibido !== edicaoSalva.valorAtual) {
              alteracoesNormalizadas = alteracoesNormalizadas.map(a =>
                String(a).replace(edicaoSalva.valorAtual, valorExibido)
              );
            }
          }
        } else if (ehRetencao || /\bmin\b/i.test(edicaoSalva.valorAtual)) {
          const matchMin = String(edicaoSalva.valorAtual)
            .replace(/\./g, "")
            .match(/(\d+(?:[.,]\d+)?)/);
          if (matchMin) {
            const minsNum = Number(matchMin[1].replace(",", "."));
            if (Number.isFinite(minsNum)) {
              valorExibido = `${formatarNumero(minsNum, 0)} min`;
              resumoAlertaFinal = `${rotuloRetencao} (${valorExibido})`;
              if (valorExibido !== edicaoSalva.valorAtual) {
                alteracoesNormalizadas = alteracoesNormalizadas.map(a =>
                  String(a).replace(edicaoSalva.valorAtual, valorExibido)
                );
              }
            }
          }
        }
      }

      const temPlacaValidaFinal = placa && placa !== "—";
      const attrsInterativosFinais = temPlacaValidaFinal
        ? `data-alert-plate="${escaparHtml(placa)}" data-placa="${escaparHtml(placa)}" data-alert-summary="${escaparHtml(resumoAlertaFinal)}" role="button" tabindex="0" title="Clique para inspecionar o veículo ${escaparHtml(placa)} em Movimentações"`
        : "";
      const classeClicavelFinal = temPlacaValidaFinal ? " alertas__item--clicavel" : "";

      const badgeEditadoHtml = edicaoSalva
        ? `<span class="alertas__editado-badge">${idiomaAtual === "en-US" ? "Edited" : "Editado"}</span>`
        : "";
      const resumoEditadoTexto =
        edicaoSalva && alteracoesNormalizadas.length
          ? `${idiomaAtual === "en-US" ? "Edited" : "Editado"} · ${alteracoesNormalizadas.join(" · ")}`
          : "";
      const resumoEditadoHtml = resumoEditadoTexto
        ? `<p class="alertas__edicao-resumo">${escaparHtml(resumoEditadoTexto)}</p>`
        : "";

      const edicaoParaModal = edicaoSalva
        ? { ...edicaoSalva, alteracoes: alteracoesNormalizadas }
        : null;

      mapaAlertasRenderizados.set(chaveAlerta, {
        chave: chaveAlerta,
        tipo: tituloTipo,
        placa,
        etapa: etapaExibida,
        valorAtual: valorExibido,
        limite: limiteExibido,
        original: {
          etapa: etapaOriginal,
          valorAtual: valorOriginal,
          limite: limiteOriginal
        },
        edicao: edicaoParaModal
      });

      return `
        <div class="alertas__item alertas__item--critico${classeClicavelFinal}" ${attrsInterativosFinais}>
          <span class="alertas__icone">!</span>
          <div class="alertas__conteudo">
            <strong>${escaparHtml(tituloTipo)} · Placa ${escaparHtml(placa)}</strong>
            <p>
              Etapa: <strong>${escaparHtml(etapaExibida)}</strong> ·
              Valor atual: <strong>${escaparHtml(valorExibido)}</strong>
              (Limite: ${escaparHtml(limiteExibido)})
            </p>
            ${resumoEditadoHtml}
          </div>
          <div class="alertas__acoes">
            ${badgeEditadoHtml}
            <span class="alertas__nivel">${escaparHtml(t("alerts.badge_critical"))}</span>
            <button type="button" class="alertas__resolver-btn" data-action="resolve-alert" data-alert-key="${escaparHtml(chaveAlerta)}">${escaparHtml(labelResolver)}</button>
          </div>
        </div>
      `;
    })
    .join("");
}

/* -----------------------------------------
   4. GET /operacao/etapas
----------------------------------------- */
function obterClasseStatusEtapa(statusOperacional) {
  const status = normalizarTexto(statusOperacional).toUpperCase();
  if (status.includes("CRITICO")) {
    return "esteira__etapa--critico";
  }
  if (status.includes("ATENCAO")) {
    return "esteira__etapa--atencao";
  }
  return "esteira__etapa--normal";
}

function formatarStatusOperacional(statusOperacional) {
  const status = normalizarTexto(statusOperacional).toUpperCase();
  if (status.includes("CRITICO")) {
    return idiomaAtual === "en-US" ? "CRITICAL" : "CRÍTICO";
  }
  if (status.includes("ATENCAO")) {
    return idiomaAtual === "en-US" ? "ATTENTION" : "ATENÇÃO";
  }
  return "NORMAL";
}

function renderizarCardsAreaPrimaria(listaEtapas) {
  const gradeEsteira = document.querySelector(".grade-esteira");
  if (!gradeEsteira) return;

  const etapas = Array.isArray(listaEtapas) && listaEtapas.length > 0
    ? listaEtapas
    : (Array.isArray(ultimasEtapasAPI) && ultimasEtapasAPI.length > 0 ? ultimasEtapasAPI : []);

  const todosVeiculos = typeof obterFonteVeiculosCompleta === "function" ? obterFonteVeiculosCompleta() : [];

  const gSemColetorQtd = todosVeiculos.filter(v => pertenceAoGrupoAreaPrimaria(v.stage, "sem_coletor")).length;
  const gColetorBalancaQtd = todosVeiculos.filter(v => pertenceAoGrupoAreaPrimaria(v.stage, "coletor_balanca")).length;
  const gBalancaPanQtd = todosVeiculos.filter(v => pertenceAoGrupoAreaPrimaria(v.stage, "balanca_pan")).length;
  const gTotalQtd = gSemColetorQtd + gColetorBalancaQtd + gBalancaPanQtd;

  const dadosGrupos = {
    sem_coletor: {
      somaPonderadaTempo: 0,
      pesoTotalTempo: 0,
      tempoLimite: 30,
      tempoPadrao: 18.0
    },
    coletor_balanca: {
      somaPonderadaTempo: 0,
      pesoTotalTempo: 0,
      tempoLimite: 30,
      tempoPadrao: 32.0
    },
    balanca_pan: {
      somaPonderadaTempo: 0,
      pesoTotalTempo: 0,
      tempoLimite: 25,
      tempoPadrao: 22.0
    }
  };

  if (etapas.length > 0) {
    etapas.forEach(item => {
      const nomeEtapaBruto = item.etapa ?? item.nome ?? item[0] ?? "";
      const nomeEtapa = normalizarRotuloEtapa(nomeEtapaBruto) || nomeEtapaBruto;
      const qtdItem = Number(item.quantidade_veiculos ?? item.qtd ?? item[1] ?? 0);
      const tempoMedioItem = Number(item.tempo_medio_permanencia_min ?? item.tempo_medio ?? (Array.isArray(item) ? 0 : 0));
      const tempoLimiteItem = Number(item.tempo_limite_min ?? item.tempo_limite ?? 0);

      let grupoAlvo = null;
      if (pertenceAoGrupoAreaPrimaria(nomeEtapa, "sem_coletor")) {
        grupoAlvo = dadosGrupos.sem_coletor;
      } else if (pertenceAoGrupoAreaPrimaria(nomeEtapa, "coletor_balanca")) {
        grupoAlvo = dadosGrupos.coletor_balanca;
      } else if (pertenceAoGrupoAreaPrimaria(nomeEtapa, "balanca_pan")) {
        grupoAlvo = dadosGrupos.balanca_pan;
      }

      if (grupoAlvo) {
        if (tempoMedioItem > 0) {
          const peso = qtdItem > 0 ? qtdItem : 1;
          grupoAlvo.somaPonderadaTempo += tempoMedioItem * peso;
          grupoAlvo.pesoTotalTempo += peso;
        }
        if (tempoLimiteItem > 0) {
          grupoAlvo.tempoLimite = tempoLimiteItem;
        }
      }
    });
  }

  const temDadosAPI = etapas.length > 0;

  const gSemColetorTempo = temDadosAPI && dadosGrupos.sem_coletor.pesoTotalTempo > 0
    ? dadosGrupos.sem_coletor.somaPonderadaTempo / dadosGrupos.sem_coletor.pesoTotalTempo
    : 18.0;
  const gSemColetorLim = dadosGrupos.sem_coletor.tempoLimite || 30;

  const gColetorBalancaTempo = temDadosAPI && dadosGrupos.coletor_balanca.pesoTotalTempo > 0
    ? dadosGrupos.coletor_balanca.somaPonderadaTempo / dadosGrupos.coletor_balanca.pesoTotalTempo
    : 32.0;
  const gColetorBalancaLim = dadosGrupos.coletor_balanca.tempoLimite || 30;

  const gBalancaPanTempo = temDadosAPI && dadosGrupos.balanca_pan.pesoTotalTempo > 0
    ? dadosGrupos.balanca_pan.somaPonderadaTempo / dadosGrupos.balanca_pan.pesoTotalTempo
    : 22.0;
  const gBalancaPanLim = dadosGrupos.balanca_pan.tempoLimite || 25;

  const somaTotalPonderada =
    dadosGrupos.sem_coletor.somaPonderadaTempo +
    dadosGrupos.coletor_balanca.somaPonderadaTempo +
    dadosGrupos.balanca_pan.somaPonderadaTempo;
  const pesoTotalPonderado =
    dadosGrupos.sem_coletor.pesoTotalTempo +
    dadosGrupos.coletor_balanca.pesoTotalTempo +
    dadosGrupos.balanca_pan.pesoTotalTempo;

  const gTotalTempo = temDadosAPI && pesoTotalPonderado > 0
    ? somaTotalPonderada / pesoTotalPonderado
    : 24.5;
  const gTotalLim = 45;

  // Cálculo de status diretamente a partir da média e do limite exibidos no próprio card:
  // - Se media > limite: CRÍTICO
  // - Se media >= limite * 0.8: ATENÇÃO
  // - Caso contrário: NORMAL
  const calcularStatusCard = (media, limite) => {
    const m = Number(media) || 0;
    const l = Number(limite) || 0;
    if (l <= 0) return "NORMAL";
    if (m > l) return "CRITICO";
    if (m >= l * 0.8) return "ATENCAO";
    return "NORMAL";
  };

  const gTotalStatus = calcularStatusCard(gTotalTempo, gTotalLim);
  const gSemColetorStatus = calcularStatusCard(gSemColetorTempo, gSemColetorLim);
  const gColetorBalancaStatus = calcularStatusCard(gColetorBalancaTempo, gColetorBalancaLim);
  const gBalancaPanStatus = calcularStatusCard(gBalancaPanTempo, gBalancaPanLim);

  const lblMedio = idiomaAtual === "en-US" ? "Avg" : "Médio";
  const lblLimite = idiomaAtual === "en-US" ? "Lim" : "Lim";

  const rotuloStatus = (status) => {
    if (status === "CRITICO") return idiomaAtual === "en-US" ? "CRITICAL" : "CRÍTICO";
    if (status === "ATENCAO") return idiomaAtual === "en-US" ? "ATTENTION" : "ATENÇÃO";
    return "NORMAL";
  };

  const statusClasse = (status) => {
    if (status === "CRITICO") return "esteira__status--critico";
    if (status === "ATENCAO") return "esteira__status--atencao";
    return "esteira__status--normal";
  };

  const tituloTotal = t("primary_area.total") || "Total na Área Primária";
  const descTotal = t("primary_area.total_title") || "Clique para filtrar todos os veículos na Área Primária";

  const tituloSemColetor = t("primary_area.without_collector") || "Sem passar no Coletor";
  const descSemColetor = t("primary_area.without_collector_title") || "Clique para filtrar veículos sem passar no coletor (Fila PRC + Pátio)";

  const tituloColetorBalanca = t("primary_area.between_collector_scale") || "Entre Coletor e Balança";
  const descColetorBalanca = t("primary_area.between_collector_scale_title") || "Clique para filtrar veículos em operação (entre coletor e balança)";

  const tituloBalancaPan = t("primary_area.between_scale_pan") || "Entre Balança e PAN";
  const descBalancaPan = t("primary_area.between_scale_pan_title") || "Clique para filtrar veículos de Balança (Tara/Bruto) e PAN";

  gradeEsteira.innerHTML = `
    <article class="esteira__etapa card-area-primaria card-area-primaria--total" data-group-filter="total" title="${escaparHtml(descTotal)}">
      <span class="card-area-primaria__titulo">${escaparHtml(tituloTotal)}</span>
      <strong class="card-area-primaria__valor">${gTotalQtd}</strong>
      <small class="esteira__tempo">${lblMedio}: ${escaparHtml(formatarNumero(gTotalTempo, 1))} min / ${lblLimite}: ${gTotalLim} min</small>
      <span class="esteira__status ${statusClasse(gTotalStatus)}">${escaparHtml(rotuloStatus(gTotalStatus))}</span>
    </article>

    <article class="esteira__etapa card-area-primaria card-area-primaria--sem-coletor" data-group-filter="sem_coletor" title="${escaparHtml(descSemColetor)}">
      <span class="card-area-primaria__titulo">${escaparHtml(tituloSemColetor)}</span>
      <strong class="card-area-primaria__valor">${gSemColetorQtd}</strong>
      <small class="esteira__tempo">${lblMedio}: ${escaparHtml(formatarNumero(gSemColetorTempo, 1))} min / ${lblLimite}: ${gSemColetorLim} min</small>
      <span class="esteira__status ${statusClasse(gSemColetorStatus)}">${escaparHtml(rotuloStatus(gSemColetorStatus))}</span>
    </article>

    <article class="esteira__etapa card-area-primaria card-area-primaria--coletor-balanca" data-group-filter="coletor_balanca" title="${escaparHtml(descColetorBalanca)}">
      <span class="card-area-primaria__titulo">${escaparHtml(tituloColetorBalanca)}</span>
      <strong class="card-area-primaria__valor">${gColetorBalancaQtd}</strong>
      <small class="esteira__tempo">${lblMedio}: ${escaparHtml(formatarNumero(gColetorBalancaTempo, 1))} min / ${lblLimite}: ${gColetorBalancaLim} min</small>
      <span class="esteira__status ${statusClasse(gColetorBalancaStatus)}">${escaparHtml(rotuloStatus(gColetorBalancaStatus))}</span>
    </article>

    <article class="esteira__etapa card-area-primaria card-area-primaria--balanca-pan" data-group-filter="balanca_pan" title="${escaparHtml(descBalancaPan)}">
      <span class="card-area-primaria__titulo">${escaparHtml(tituloBalancaPan)}</span>
      <strong class="card-area-primaria__valor">${gBalancaPanQtd}</strong>
      <small class="esteira__tempo">${lblMedio}: ${escaparHtml(formatarNumero(gBalancaPanTempo, 1))} min / ${lblLimite}: ${gBalancaPanLim} min</small>
      <span class="esteira__status ${statusClasse(gBalancaPanStatus)}">${escaparHtml(rotuloStatus(gBalancaPanStatus))}</span>
    </article>
  `;

  if (typeof atualizarBadgesFluxoConvencional === "function") {
    atualizarBadgesFluxoConvencional(todosVeiculos);
  }
  if (typeof atualizarBotaoFluxoExpedicao === "function") {
    atualizarBotaoFluxoExpedicao(todosVeiculos);
  }
}

async function carregarEtapasOperacao() {
  try {
    const resposta = await fetchComTimeout(`${API_BASE_URL}/operacao/etapas`);
    if (!resposta.ok) {
      throw new Error(`Erro HTTP ${resposta.status} em /operacao/etapas`);
    }

    const dados = await resposta.json();
    const listaEtapas = Array.isArray(dados)
      ? dados
      : dados.etapas || dados.items || dados.data || [];

    if (!listaEtapas.length) return true;

    etapasCarregadasPorEndpoint = true;
    ultimasEtapasAPI = listaEtapas;

    renderizarCardsAreaPrimaria(listaEtapas);

    const nomesEtapas = listaEtapas
      .map(e => normalizarRotuloEtapa(e.etapa) || e.etapa)
      .filter(Boolean);
    atualizarOpcoesSelect("movement-etapa", nomesEtapas, "Todas", ETAPAS_PADRAO);
    atualizarBannerInspecaoMovimentacoes();

    return true;
  } catch (erro) {
    console.warn("⚠️ [API] Não foi possível carregar /operacao/etapas:", erro.message);
    return false;
  }
}

/* -----------------------------------------
   5. GET /operacao/bercos
----------------------------------------- */
function obterClasseStatusBerco(statusOperacional) {
  const status = normalizarTexto(statusOperacional).toUpperCase();
  if (status.includes("CRITICO")) {
    return "berco__status--critico";
  }
  if (status.includes("ATENCAO") || status.includes("ABAIXO")) {
    return "berco__status--atencao";
  }
  return "berco__status--positivo";
}

async function carregarBercosOperacao() {
  try {
    const resposta = await fetchComTimeout(`${API_BASE_URL}/operacao/bercos`);
    if (!resposta.ok) {
      throw new Error(`Erro HTTP ${resposta.status} em /operacao/bercos`);
    }

    const dados = await resposta.json();
    const listaBercos = Array.isArray(dados)
      ? dados
      : dados.bercos || dados.pontos_operacionais || dados.items || dados.data || [];

    if (!listaBercos.length) return true;

    // Atualiza opções do select de destinos com base nos berços ativos
    const destinosUnicos = listaBercos
      .map(b => b.berco_destino ?? b.nome)
      .filter(Boolean);
    atualizarOpcoesSelect("movement-destino", destinosUnicos, t("filter.all_masc"), DESTINOS_PADRAO);
    atualizarBannerInspecaoMovimentacoes();

    return true;
  } catch (erro) {
    console.warn("⚠️ [API] Não foi possível carregar /operacao/bercos:", erro.message);
    return false;
  }
}

/* -----------------------------------------
   FALLBACKS DO /dashboard/resumo
----------------------------------------- */
function renderizarBercosResumoFallback(pontosOperacionais) {
  if (!Array.isArray(pontosOperacionais) || !pontosOperacionais.length) return;
  ultimosBercosAPI = pontosOperacionais;
  const cardsBercos = document.querySelectorAll(".grade-bercos .berco");

  pontosOperacionais.forEach((ponto, index) => {
    const card = cardsBercos[index];
    if (!card) return;

    let nomePonto = ponto.nome || (ponto.berco_destino ? `Berço ${ponto.berco_destino}` : "") || card.dataset.bercoFilter || `Berço ${index + 1}`;
    if (/^ber[çc]o\s*99$/i.test(nomePonto)) nomePonto = "Berço 99";
    else if (/^ber[çc]o\s*101$/i.test(nomePonto)) nomePonto = "Berço 101";
    else if (/^ber[çc]o\s*102$/i.test(nomePonto)) nomePonto = "Berço 102";
    else if (/^expedi[çc][ãa]o$/i.test(nomePonto)) nomePonto = "Expedição";

    card.dataset.bercoFilter = nomePonto;
    const elTitulo = card.querySelector(".berco__titulo");
    if (elTitulo) elTitulo.textContent = traduzirDestino(nomePonto);

    const elCarga = card.querySelector(".berco__carga");
    if (elCarga) elCarga.textContent = ponto.tipo_carga || "Operação integrada";

    const prancha = ponto.prancha_atual_th ?? ponto.prancha_th ?? 0;
    const elProdStrong = card.querySelector(".berco__produtividade strong");
    if (elProdStrong) {
      elProdStrong.textContent = `${formatarNumero(prancha, 0)} t/h`;
    }

    const ehExpedicao = nomePonto === "Expedição";
    const metaRaw = ponto.meta_contratual_th ?? ponto.meta_th ?? 0;
    // Norma/COPI define 250 t/h para Expedição Rodoviária, mesmo se API/fallback enviar 300
    const meta = ehExpedicao ? 250 : metaRaw;
    const atingimento = ehExpedicao
      ? (meta > 0 ? (Number(prancha) / meta) * 100 : 0)
      : (ponto.atingimento_percentual ?? ponto.atingimento ?? 100);

    const elProdSpan = card.querySelector(".berco__produtividade span");
    if (elProdSpan) {
      elProdSpan.textContent =
        idiomaAtual === "en-US"
          ? `${formatarNumero(atingimento, 1)}% of target`
          : `${formatarNumero(atingimento, 1)}% da meta`;
    }

    const elRefStrong = card.querySelector(".berco__referencia strong");
    if (elRefStrong) {
      elRefStrong.textContent = `${formatarNumero(meta, 0)} t/h`;
    }

    const statusTexto = ponto.status ?? ponto.status_operacional ?? "Na meta";
    const badgeStatus = card.querySelector(".berco__status");
    if (badgeStatus) {
      badgeStatus.textContent = traduzirSituacao(statusTexto);
      badgeStatus.className = `berco__status ${obterClasseStatusBerco(statusTexto)}`;
    }

    const barraProgresso = card.querySelector(".berco__progresso span");
    if (barraProgresso) {
      barraProgresso.style.width = `${Math.min(Math.max(Number(atingimento) || 0, 0), 100)}%`;
    }

    const detalhes = card.querySelectorAll(".berco__detalhes strong");
    if (detalhes.length >= 2) {
      const volTon = ponto.volume_acumulado_ton !== undefined && ponto.volume_acumulado_ton !== null
        ? Number(ponto.volume_acumulado_ton)
        : (ponto.volume_total_movimentado_kg ? Number(ponto.volume_total_movimentado_kg) / 1000 : 0);
      detalhes[0].textContent = `${formatarNumero(volTon, 1)} t`;
      detalhes[1].textContent = ponto.veiculos_alocados ?? ponto.total_veiculos_ativos ?? 0;
    }
  });

  const nomesBercos = pontosOperacionais.map(p => p.nome).filter(Boolean);
  atualizarOpcoesSelect("movement-destino", nomesBercos, t("filter.all_masc"), DESTINOS_PADRAO);
  atualizarBannerInspecaoMovimentacoes();

  if (typeof atualizarRitmoBerco101FluxoMecanizado === "function") {
    atualizarRitmoBerco101FluxoMecanizado(pontosOperacionais);
  }
  if (typeof atualizarPranchaExpedicaoFluxo === "function") {
    atualizarPranchaExpedicaoFluxo();
  }
}

function renderizarEtapasResumoFallback(esteira) {
  const valores = [
    { etapa: "Fila PRC", quantidade_veiculos: esteira.fila_prc ?? 0, tempo_medio_permanencia_min: 18, tempo_limite_min: 30, status_operacional: "ATENCAO" },
    { etapa: "PAN", quantidade_veiculos: esteira.pan ?? 0, tempo_medio_permanencia_min: 22, tempo_limite_min: 25, status_operacional: "NORMAL" },
    { etapa: "Balança Tara", quantidade_veiculos: esteira.balanca_tara ?? 0, tempo_medio_permanencia_min: 20, tempo_limite_min: 25, status_operacional: "NORMAL" },
    { etapa: "Pátio", quantidade_veiculos: esteira.patio ?? 0, tempo_medio_permanencia_min: 18, tempo_limite_min: 30, status_operacional: "NORMAL" },
    { etapa: "Operação", quantidade_veiculos: esteira.operacao ?? 0, tempo_medio_permanencia_min: 32, tempo_limite_min: 30, status_operacional: "ATENCAO" },
    { etapa: "Balança Bruto", quantidade_veiculos: esteira.balanca_bruto ?? 0, tempo_medio_permanencia_min: 24, tempo_limite_min: 25, status_operacional: "CRITICO" }
  ];

  ultimasEtapasAPI = valores;
  renderizarCardsAreaPrimaria(valores);
  atualizarBannerInspecaoMovimentacoes();
}

function renderizarAlertasResumoFallback(alertasCriticos) {
  renderizarListaAlertasDOM(alertasCriticos);
}

/* -----------------------------------------
   ORQUESTRADOR DE SINCRONIZAÇÃO (5 ENDPOINTS)
----------------------------------------- */
function agendarProximoPolling() {
  clearTimeout(pollingTimeoutId);
  pollingTimeoutId = null;

  if (document.visibilityState === "hidden") {
    return;
  }

  const intervalo = Math.max(5000, Number(INTERVALO_ATUALIZACAO_MS) || 30000);
  pollingTimeoutId = setTimeout(() => {
    sincronizarTodosEndpoints();
  }, intervalo);
}

async function sincronizarTodosEndpoints() {
  if (sincronizacaoEmAndamento) return apiConectada;
  sincronizacaoEmAndamento = true;
  clearTimeout(pollingTimeoutId);
  pollingTimeoutId = null;

  try {
    const resultados = await Promise.allSettled([
      carregarResumoDashboard(),
      carregarBercosOperacao(),
      carregarEtapasOperacao(),
      carregarAlertasVeiculos(),
      carregarVeiculos({ destino: "all", etapa: "all" })
    ]);

    const algumOnline = resultados.some(
      resultado => resultado.status === "fulfilled" && resultado.value === true
    );

    if (algumOnline) {
      atualizarStatusConexaoUI(true, ultimoResumoAPI?.timestamp);
    } else {
      console.warn(
        `⚠️ [CCO Front-end] Back-end FastAPI (${API_BASE_URL}) está offline ou inacessível. Mantendo dados demonstrativos na interface.`
      );
      atualizarStatusConexaoUI(false);
    }
    return algumOnline;
  } finally {
    sincronizacaoEmAndamento = false;
    agendarProximoPolling();
  }
}

/* =========================================
   DADOS DEMONSTRATIVOS (FALLBACK LOCAL)
========================================= */

const movements = [
  {
    plate: "BRA2E19",
    ticket: "MOV-2026-00001",
    statusTicket: "2 - Alterado",
    unidade: "COPISI",
    tipoMovimentacao: "Entrada",
    cliente: "Vale S.A.",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "DI",
    numeroDocumentoLote: "26/0410101-1",
    localFisico: "Berço 99 · Box A1",
    dataMovimentacao: "14/11/2026 08:15",
    pesoMovimentadoKg: 31120,
    ship: "PRESTIGE DIVA",
    flow: "Berço 99",
    window: "311",
    bl: "BL-ITAQUI-001",
    driver: "Carlos Almeida",
    carrier: "Transporte Alfa",
    operation: "Recebimento",
    entry: "08:15",
    entryPAN: "14/11/2026 08:15",
    axles: 6,
    tareWeight: "17.080",
    tareDate: "14/11/2026 08:30",
    collectorDate: "14/11/2026 08:50",
    grossWeight: "48.200",
    netWeight: "31.120",
    grossDate: "14/11/2026 09:20",
    overweight: "Sim (+3,2 t)",
    exit: "—",
    duration: "138 min",
    durationMin: 138,
    stage: "Balança Bruto",
    status: "Parado",
    possui_alerta: true
  },
  {
    plate: "LXP-4A23",
    ticket: "MOV-2026-00002",
    statusTicket: "1 - Ativo",
    unidade: "COPISI",
    tipoMovimentacao: "Saída",
    cliente: "Suzano S.A.",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "BL",
    numeroDocumentoLote: "BL-ITQ-2026-102",
    localFisico: "Berço 99 · Pátio Tara",
    dataMovimentacao: "14/11/2026 08:25",
    pesoMovimentadoKg: 17200,
    ship: "PRESTIGE DIVA",
    flow: "Berço 99",
    window: "315",
    bl: "BL-ITAQUI-002",
    driver: "Roberto Nascimento",
    carrier: "Transporte Alfa",
    operation: "Expedição",
    entry: "08:25",
    entryPAN: "14/11/2026 08:25",
    axles: 6,
    tareWeight: "17.200",
    tareDate: "14/11/2026 08:40",
    collectorDate: "—",
    grossWeight: null,
    netWeight: null,
    grossDate: "—",
    overweight: "Alerta (Fila)",
    exit: "—",
    duration: "110 min",
    durationMin: 110,
    stage: "Balança Tara",
    status: "Parado",
    possui_alerta: true
  },
  {
    plate: "QWF-7F56",
    ticket: "MOV-2026-00003",
    statusTicket: "1 - Ativo",
    unidade: "VM",
    tipoMovimentacao: "Entrada",
    cliente: "VLI Multimodal",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "DI",
    numeroDocumentoLote: "26/0410103-8",
    localFisico: "Berço 99 · Box B2",
    dataMovimentacao: "14/11/2026 07:42",
    pesoMovimentadoKg: 26860,
    ship: "PRESTIGE DIVA",
    flow: "Berço 99",
    window: "112",
    bl: "BL-ITAQUI-003",
    driver: "Marcos Oliveira",
    carrier: "Translog",
    operation: "Recebimento",
    entry: "07:42",
    entryPAN: "14/11/2026 07:42",
    axles: 6,
    tareWeight: "18.340",
    tareDate: "14/11/2026 07:55",
    collectorDate: "14/11/2026 08:10",
    grossWeight: "45.200",
    netWeight: "26.860",
    grossDate: "14/11/2026 08:40",
    overweight: "Não",
    exit: "09:05",
    duration: "83 min",
    durationMin: 83,
    stage: "Gate-out",
    status: "Finalizado",
    possui_alerta: false
  },
  {
    plate: "BCD-3021",
    ticket: "MOV-2026-00004",
    statusTicket: "1 - Ativo",
    unidade: "VM",
    tipoMovimentacao: "Saída",
    cliente: "Raízen Combustíveis",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "BL",
    numeroDocumentoLote: "BL-ITQ-2026-104",
    localFisico: "Berço 101 · Moega 02",
    dataMovimentacao: "14/11/2026 08:30",
    pesoMovimentadoKg: 17100,
    ship: "PRESTIGE DIVA",
    flow: "Berço 101",
    window: "211",
    bl: "BL-ITAQUI-004",
    driver: "João Ferreira",
    carrier: "Veloz Cargas",
    operation: "Expedição",
    entry: "08:30",
    entryPAN: "14/11/2026 08:30",
    axles: 7,
    tareWeight: "17.100",
    tareDate: "14/11/2026 08:45",
    collectorDate: "—",
    grossWeight: null,
    netWeight: null,
    grossDate: "—",
    overweight: "Não",
    exit: "—",
    duration: "45 min",
    durationMin: 45,
    stage: "Operação",
    status: "Em operação",
    possui_alerta: false
  },
  {
    plate: "EFG-8H76",
    ticket: "MOV-2026-00005",
    statusTicket: "1 - Ativo",
    unidade: "TIPA",
    tipoMovimentacao: "Entrada",
    cliente: "Cargill Agrícola",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "DI",
    numeroDocumentoLote: "26/0410105-4",
    localFisico: "Berço 102 · Silo Sul",
    dataMovimentacao: "14/11/2026 06:55",
    pesoMovimentadoKg: 27900,
    ship: "PRESTIGE DIVA",
    flow: "Berço 102",
    window: "311",
    bl: "BL-ITAQUI-005",
    driver: "Pedro Santos",
    carrier: "Rota Sul",
    operation: "Recebimento",
    entry: "06:55",
    entryPAN: "14/11/2026 06:55",
    axles: 6,
    tareWeight: "18.900",
    tareDate: "14/11/2026 07:10",
    collectorDate: "14/11/2026 07:25",
    grossWeight: "46.800",
    netWeight: "27.900",
    grossDate: "14/11/2026 07:50",
    overweight: "Não",
    exit: "08:20",
    duration: "85 min",
    durationMin: 85,
    stage: "Balança Bruto",
    status: "Finalizado",
    possui_alerta: false
  },
  {
    plate: "JKL-2M34",
    ticket: "MOV-2026-00006",
    statusTicket: "1 - Ativo",
    unidade: "COPISI",
    tipoMovimentacao: "Saída",
    cliente: "Suzano S.A.",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "BL",
    numeroDocumentoLote: "BL-ITQ-2026-106",
    localFisico: "Berço 99 · Fila PRC",
    dataMovimentacao: "14/11/2026 09:12",
    pesoMovimentadoKg: 16860,
    ship: "PRESTIGE DIVA",
    flow: "Berço 99",
    window: "411",
    bl: "BL-ITAQUI-006",
    driver: "Rafael Costa",
    carrier: "Transporte Alfa",
    operation: "Expedição",
    entry: "09:12",
    entryPAN: "14/11/2026 09:12",
    axles: 6,
    tareWeight: "16.860",
    tareDate: "—",
    collectorDate: "—",
    grossWeight: null,
    netWeight: null,
    grossDate: "—",
    overweight: "Não",
    exit: "—",
    duration: "28 min",
    durationMin: 28,
    stage: "Fila PRC",
    status: "Em operação",
    possui_alerta: false
  },
  {
    plate: "MNO-5P67",
    ticket: "MOV-2026-00007",
    statusTicket: "1 - Ativo",
    unidade: "VM",
    tipoMovimentacao: "Entrada",
    cliente: "Vale S.A.",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "DI",
    numeroDocumentoLote: "26/0410107-0",
    localFisico: "Berço 101 · Box C4",
    dataMovimentacao: "14/11/2026 10:05",
    pesoMovimentadoKg: 26400,
    ship: "PRESTIGE DIVA",
    flow: "Berço 101",
    window: "211",
    bl: "BL-ITAQUI-007",
    driver: "Lucas Martins",
    carrier: "Logística Brasil",
    operation: "Recebimento",
    entry: "10:05",
    entryPAN: "14/11/2026 10:05",
    axles: 7,
    tareWeight: "17.600",
    tareDate: "14/11/2026 10:20",
    collectorDate: "14/11/2026 10:35",
    grossWeight: "44.000",
    netWeight: "26.400",
    grossDate: "14/11/2026 11:10",
    overweight: "Não",
    exit: "11:40",
    duration: "95 min",
    durationMin: 95,
    stage: "Operação",
    status: "Finalizado",
    possui_alerta: false
  },
  {
    plate: "PQR-8T90",
    ticket: "MOV-2026-00008",
    statusTicket: "1 - Ativo",
    unidade: "TIPA",
    tipoMovimentacao: "Saída",
    cliente: "Bunge Alimentos",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "BL",
    numeroDocumentoLote: "BL-ITQ-2026-108",
    localFisico: "Berço 102 · Triagem PAN",
    dataMovimentacao: "14/11/2026 10:32",
    pesoMovimentadoKg: null,
    ship: "PRESTIGE DIVA",
    flow: "Berço 102",
    window: "411",
    bl: "BL-ITAQUI-008",
    driver: "André Lima",
    carrier: "Veloz Cargas",
    operation: "Expedição",
    entry: "10:32",
    entryPAN: "14/11/2026 10:32",
    axles: 6,
    tareWeight: null,
    tareDate: "—",
    collectorDate: "—",
    grossWeight: null,
    netWeight: null,
    grossDate: "—",
    overweight: "Não",
    exit: "—",
    duration: "12 min",
    durationMin: 12,
    stage: "PAN",
    status: "Em operação",
    possui_alerta: false
  },
  {
    plate: "STU-2V13",
    ticket: "MOV-2026-00009",
    statusTicket: "1 - Ativo",
    unidade: "TIPA",
    tipoMovimentacao: "Saída",
    cliente: "Alumar Consórcio",
    referencia: "PRESTIGE DIVA",
    tipoDocumentoLote: "BL",
    numeroDocumentoLote: "BL-ITQ-2026-109",
    localFisico: "Armazém Expedição · Box E1",
    dataMovimentacao: "14/11/2026 11:20",
    pesoMovimentadoKg: 23800,
    ship: "PRESTIGE DIVA",
    flow: "Expedição",
    window: "311",
    bl: "BL-ITAQUI-009",
    driver: "Felipe Rocha",
    carrier: "Translog",
    operation: "Expedição",
    entry: "11:20",
    entryPAN: "14/11/2026 11:20",
    axles: 6,
    tareWeight: "18.200",
    tareDate: "14/11/2026 11:30",
    collectorDate: "14/11/2026 11:40",
    grossWeight: "42.000",
    netWeight: "23.800",
    grossDate: "14/11/2026 11:55",
    overweight: "Não",
    exit: "12:10",
    duration: "50 min",
    durationMin: 50,
    stage: "Gate-out",
    status: "Finalizado",
    possui_alerta: false
  }
];

const carriersBase = [
  { name: "Transporte Alfa", prancha: "88 t/h" },
  { name: "Translog", prancha: "82 t/h" },
  { name: "Veloz Cargas", prancha: "76 t/h" },
  { name: "Rota Sul", prancha: "68 t/h" },
  { name: "Logística Brasil", prancha: "63 t/h" }
];

/* =========================================
   INFORMAÇÕES DAS PÁGINAS
========================================= */

const pageDetails = {
  overview: [
    "Acompanhamento da Movimentação Rodoviária",
    "Visão geral da operação em um só lugar"
  ],
  movements: [
    "Movimentações de Veículos",
    "Consulte e acompanhe as movimentações da operação"
  ],
  carriers: [
    "Transportadoras",
    "Compare o volume e os indicadores por transportadora"
  ],
  reports: [
    "Relatórios",
    "Consulte relatórios disponíveis e organize suas análises"
  ],
  settings: [
    "Configurações",
    "Preferências de visualização do painel"
  ],
  vehicles: [
    "Cadastro de Veículos",
    "Cadastre e gerencie os veículos da operação"
  ]
};

/* =========================================
   ELEMENTOS DA INTERFACE
========================================= */

const navButtons = document.querySelectorAll(".menu__link");
const pages = document.querySelectorAll(".pagina");
const toast = document.getElementById("toast");

let toastTimeout;

/* =========================================
   NOTIFICAÇÕES
========================================= */

function notify(message, tipo = "padrao", duracao = 2800) {
  if (!toast) return;
  toast.textContent = message;
  toast.className = "notificacao notificacao--visivel";

  if (tipo === "sucesso") {
    toast.classList.add("notificacao--sucesso");
  } else if (tipo === "erro" || tipo === "alerta") {
    toast.classList.add("notificacao--erro");
  } else if (tipo === "sincronizando") {
    toast.classList.add("notificacao--sincronizando");
  }

  clearTimeout(toastTimeout);

  if (duracao > 0) {
    toastTimeout = setTimeout(() => {
      toast.classList.remove("notificacao--visivel");
    }, duracao);
  }
}

/* =========================================
   NAVEGAÇÃO ENTRE PÁGINAS
========================================= */

let paginaAtualNome = "overview";

function atualizarTituloPaginaAtual() {
  const pageTitle = document.getElementById("page-title");
  if (pageTitle) {
    pageTitle.textContent = t(`page.${paginaAtualNome}.title`);
  }
}

function showPage(name) {
  if (!pageDetails[name]) return;
  paginaAtualNome = name;

  pages.forEach(page => {
    page.classList.toggle("pagina--ativa", page.id === `page-${name}`);
  });

  navButtons.forEach(button => {
    button.classList.toggle("menu__link--ativo", button.dataset.page === name);
  });

  atualizarTituloPaginaAtual();

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}

navButtons.forEach(button => {
  button.addEventListener("click", () => {
    showPage(button.dataset.page);
  });
});

document.querySelectorAll("[data-goto]").forEach(button => {
  button.addEventListener("click", () => {
    showPage(button.dataset.goto);
  });
});

/* =========================================
   ATALHO DOS CARDS (BERÇOS E ETAPAS) + BANNER DE RESUMO
========================================= */

function selecionarOpcaoEquivalente(selectEl, valorAlvo) {
  if (!selectEl || !valorAlvo) return;
  const opcoes = Array.from(selectEl.options).filter(opt => opt.value !== "all");

  let alvoNormalizado = String(valorAlvo).replace(/^\d+\s*[.\-)]\s*/, "").trim();
  if (selectEl.id === "movement-destino") {
    alvoNormalizado = normalizarRotuloDestino(alvoNormalizado) || alvoNormalizado;
  } else if (selectEl.id === "movement-etapa") {
    alvoNormalizado = normalizarRotuloEtapa(alvoNormalizado) || alvoNormalizado;
  }

  const encontrada = opcoes.find(
    opt =>
      normalizarTexto(opt.value) === normalizarTexto(alvoNormalizado) ||
      normalizarTexto(opt.textContent).replace(/^\d+\s*[.\-)]\s*/, "") ===
        normalizarTexto(alvoNormalizado) ||
      (selectEl.id === "movement-destino" && coincidirDestino(opt.value, alvoNormalizado)) ||
      (selectEl.id === "movement-etapa" && coincidirEtapa(opt.value, alvoNormalizado))
  );

  if (encontrada) {
    selectEl.value = encontrada.value;
  } else {
    const novaOpt = document.createElement("option");
    novaOpt.value = alvoNormalizado;
    novaOpt.textContent = alvoNormalizado;
    selectEl.appendChild(novaOpt);
    selectEl.value = alvoNormalizado;
  }
}

function extrairResumoCardBerco(bercoFiltro, cardEl) {
  const itemAPI = ultimosBercosAPI.find(b =>
    coincidirDestino(b.berco_destino ?? b.nome, bercoFiltro)
  );

  if (itemAPI) {
    const ehExpedicao = coincidirDestino(bercoFiltro, "Expedição");
    const totalVeiculos = itemAPI.total_veiculos_ativos ?? itemAPI.veiculos_alocados ?? 0;
    const pranchaAtual = itemAPI.prancha_atual_th ?? itemAPI.prancha_th;
    const atingimentoExibido =
      ehExpedicao && pranchaAtual !== undefined
        ? formatarNumero((Number(pranchaAtual) / 250) * 100, 1)
        : (itemAPI.atingimento_percentual ?? 100);
    const tempoOuPrancha =
      itemAPI.tempo_medio_atendimento_min !== undefined
        ? `Tempo médio: ${formatarNumero(itemAPI.tempo_medio_atendimento_min, 1)} min`
        : pranchaAtual !== undefined
        ? `Prancha: ${pranchaAtual} t/h (${atingimentoExibido}% da meta)`
        : "Operação ativa";
    const volume =
      itemAPI.volume_total_movimentado_kg !== undefined
        ? `${formatarNumero(itemAPI.volume_total_movimentado_kg)} kg`
        : itemAPI.volume_acumulado_ton !== undefined
        ? `${formatarNumero(itemAPI.volume_acumulado_ton)} t`
        : null;
    const status = itemAPI.status_operacional ?? itemAPI.status ?? "NORMAL";

    return {
      tipo: "Berço / Ponto Operacional",
      nome: itemAPI.berco_destino ?? itemAPI.nome ?? bercoFiltro,
      totalVeiculos,
      tempoOuPrancha,
      volume,
      status
    };
  }

  if (cardEl) {
    const titulo = cardEl.querySelector(".berco__titulo")?.textContent?.trim() || bercoFiltro;
    const prod = cardEl.querySelector(".berco__produtividade strong")?.textContent?.trim() || "—";
    const status = cardEl.querySelector(".berco__status")?.textContent?.trim() || "Ativo";
    const detalhes = cardEl.querySelectorAll(".berco__detalhes strong");
    const volume = detalhes[0]?.textContent?.trim() || null;
    const totalVeiculos = detalhes[detalhes.length - 1]?.textContent?.trim() || "—";

    return {
      tipo: "Berço / Ponto Operacional",
      nome: titulo,
      totalVeiculos,
      tempoOuPrancha: `Produtividade: ${prod}`,
      volume,
      status
    };
  }

  return null;
}

function extrairResumoCardEtapa(etapaFiltro, cardEl) {
  const itemAPI = ultimasEtapasAPI.find(e => coincidirEtapa(e.etapa, etapaFiltro));

  if (itemAPI) {
    const totalVeiculos = itemAPI.quantidade_veiculos ?? 0;
    const tempoOuPrancha =
      itemAPI.tempo_medio_permanencia_min !== undefined
        ? `Tempo médio: ${formatarNumero(itemAPI.tempo_medio_permanencia_min, 1)} min (Limite: ${formatarNumero(itemAPI.tempo_limite_min ?? 30, 0)} min)`
        : "Monitoramento em tempo real";
    const status = itemAPI.status_operacional ?? "NORMAL";

    return {
      tipo: "Área Primária",
      nome: itemAPI.etapa ?? etapaFiltro,
      totalVeiculos,
      tempoOuPrancha,
      volume: null,
      status
    };
  }

  if (cardEl) {
    const titulo =
      cardEl.querySelector(".card-area-primaria__titulo")?.textContent?.trim() ||
      cardEl.querySelector("span")?.textContent?.trim() ||
      etapaFiltro;
    const totalVeiculos =
      cardEl.querySelector(".card-area-primaria__valor")?.textContent?.trim() ||
      cardEl.querySelector("strong")?.textContent?.trim() ||
      "0";
    const tempo = cardEl.querySelector(".esteira__tempo")?.textContent?.trim() || "Monitoramento em tempo real";
    const status = cardEl.querySelector(".esteira__status")?.textContent?.trim() || "NORMAL";

    return {
      tipo: "Área Primária",
      nome: titulo,
      totalVeiculos,
      tempoOuPrancha: tempo,
      volume: null,
      status
    };
  }

  return null;
}

function atualizarBannerInspecaoMovimentacoes() {
  const banner = document.getElementById("movement-inspection-banner");
  if (!banner) return;

  const selectDestino = document.getElementById("movement-destino");
  const selectEtapa = document.getElementById("movement-etapa");
  const inputPlaca = document.getElementById("plate-filter");
  const selectCarrier = document.getElementById("movement-carrier");

  const destinoVal = selectDestino ? selectDestino.value : "all";
  const etapaVal = selectEtapa ? selectEtapa.value : "all";
  const placaVal = inputPlaca ? inputPlaca.value.trim() : "";
  const carrierVal = selectCarrier ? selectCarrier.value : "all";

  const temInspecaoBerco = destinoVal !== "all";
  const temInspecaoEtapa = etapaVal !== "all";
  const temInspecaoAlerta = Boolean(contextoInspecaoCard?.ehAlerta && placaVal);
  const temInspecaoCarrier = Boolean(
    (contextoInspecaoCard?.ehTransportadora || contextoInspecaoCard?.tipo === "Transportadora") &&
    carrierVal !== "all"
  );
  const temInspecaoGrupo = Boolean(contextoInspecaoCard?.filtroGrupo);

  if (!temInspecaoBerco && !temInspecaoEtapa && !temInspecaoAlerta && !temInspecaoCarrier && !temInspecaoGrupo) {
    contextoInspecaoCard = null;
    banner.hidden = false;
    banner.innerHTML = `
      <div class="inspecao-banner__info">
        <div class="inspecao-banner__titulo">
          <span>${escaparHtml(t("movements.default_banner_title"))}</span>
          <span class="situacao situacao--concluido">${escaparHtml(t("movements.default_banner_status"))}</span>
        </div>
        <div class="inspecao-banner__metricas">
          <span>${escaparHtml(t("movements.default_banner_desc"))}</span>
        </div>
      </div>
    `;
    return;
  }

  let resumo = contextoInspecaoCard;
  if (!resumo) {
    if (destinoVal !== "all") {
      resumo = extrairResumoCardBerco(destinoVal, null);
    } else if (etapaVal !== "all") {
      resumo = extrairResumoCardEtapa(etapaVal, null);
    } else if (carrierVal !== "all") {
      resumo = {
        tipo: "Transportadora",
        nome: carrierVal,
        totalVeiculos: filteredMovements().length,
        tempoOuPrancha: `Transportadora: ${carrierVal}`,
        volume: null,
        status: "ATIVO",
        ehTransportadora: true
      };
    }
  }

  if (!resumo) {
    resumo = {
      tipo: destinoVal !== "all" ? "Filtro por Destino" : etapaVal !== "all" ? "Filtro por Etapa" : "Filtro por Transportadora",
      nome: destinoVal !== "all" ? destinoVal : etapaVal !== "all" ? etapaVal : carrierVal,
      totalVeiculos: filteredMovements().length,
      tempoOuPrancha: "Filtro ativo",
      volume: null,
      status: "ATIVO"
    };
  }

  if (temInspecaoAlerta && resumo?.ehAlerta && placaVal) {
    const placaNormBanner = normalizarTexto(placaVal);
    const veiculoBanner = obterFonteVeiculosCompleta().find(
      v => normalizarTexto(v.plate ?? v.placa) === placaNormBanner
    );
    if (veiculoBanner) {
      const alertaBanner = resolverAlertaVeiculo(veiculoBanner);
      const badgeCritico = (alertaBanner.badges || []).find(b => b.nivel === "critico");
      if (badgeCritico) {
        const rotuloLive = formatarRotuloAlertaParaExibicao(veiculoBanner, badgeCritico);
        resumo = {
          ...resumo,
          nome: `Placa ${placaVal} — ${rotuloLive}`,
          tempoOuPrancha: rotuloLive
        };
      } else {
        const pesoBanner = converterPesoParaNumero(
          veiculoBanner.grossWeight ??
            veiculoBanner.peso_bruto_kg ??
            veiculoBanner.peso_kg ??
            veiculoBanner.pesoNumerico
        );
        if (pesoBanner !== null) {
          const resumoPeso = `Peso atual (${formatarNumero(pesoBanner, 0)} kg)`;
          resumo = {
            ...resumo,
            nome: `Placa ${placaVal} — ${resumoPeso}`,
            tempoOuPrancha: resumoPeso
          };
        }
      }
    }
  }

  const statusUpper = normalizarTexto(resumo.status).toUpperCase();
  const classeBadge =
    statusUpper.includes("CRITICO")
      ? "situacao--parado"
      : statusUpper.includes("ATENCAO") || statusUpper.includes("ABAIXO")
      ? "situacao--andamento"
      : "situacao--concluido";

  banner.hidden = false;
  let metricasHtml = "";
  if (resumo.filtroGrupo) {
    resumo.totalVeiculos = filteredMovements().length;
    metricasHtml = `<span>Total agregado no card: <strong>${escaparHtml(resumo.totalVeiculos)} veículo(s)</strong></span>
       <span>·</span>
       <span>${escaparHtml(resumo.tempoOuPrancha)}</span>
       <span>·</span>
       <span>Registros exibidos: <strong>${escaparHtml(filteredMovements().length)} veículo(s)</strong></span>`;
  } else if (resumo.ehAlerta) {
    metricasHtml = `<span>Ocorrência: <strong>${escaparHtml(resumo.tempoOuPrancha)}</strong></span>
       <span>·</span>
       <span>Registros exibidos: <strong>${escaparHtml(filteredMovements().length)}</strong></span>`;
  } else if (resumo.ehTransportadora || resumo.tipo === "Transportadora") {
    metricasHtml = `<span>Transportadora: <strong>${escaparHtml(resumo.nome)}</strong></span>
       <span>·</span>
       <span>Registros exibidos: <strong>${escaparHtml(filteredMovements().length)} veículo(s)</strong></span>`;
  } else {
    metricasHtml = `<span>Total agregado no card: <strong>${escaparHtml(resumo.totalVeiculos)} veículo(s) no giro</strong></span>
       <span>·</span>
       <span>${escaparHtml(resumo.tempoOuPrancha)}</span>
       ${resumo.volume ? `<span>· Volume: <strong>${escaparHtml(resumo.volume)}</strong></span>` : ""}`;
  }

  const rotuloLimpar = idiomaAtual === "en-US" ? "Clear filter and view all" : "Limpar filtro e ver todos";
  const rotuloInspecao = resumo.filtroGrupo
    ? (idiomaAtual === "en-US" ? "Inspecting Primary Area" : "Inspecionando Área Primária")
    : `Inspecionando ${escaparHtml(resumo.tipo)}`;

  banner.innerHTML = `
    <div class="inspecao-banner__info">
      <div class="inspecao-banner__titulo">
        <span>${rotuloInspecao}: <strong>${escaparHtml(resumo.nome)}</strong></span>
        <span class="situacao ${classeBadge}">${escaparHtml(resumo.status)}</span>
      </div>
      <div class="inspecao-banner__metricas">
        ${metricasHtml}
      </div>
    </div>
    <button type="button" class="btn-limpar-inspecao" id="btn-limpar-inspecao-banner">
      ✕ ${rotuloLimpar}
    </button>
  `;

  const btnLimpar = banner.querySelector("#btn-limpar-inspecao-banner");
  if (btnLimpar) {
    btnLimpar.addEventListener("click", limparFiltrosMovimentacoes);
  }
}

function limparFiltrosMovimentacoes() {
  const selectUnidade = document.getElementById("movement-unidade");
  const selectDestino = document.getElementById("movement-destino");
  const selectEtapa = document.getElementById("movement-etapa");
  const inputPlaca = document.getElementById("plate-filter");
  const selectCarrier = document.getElementById("movement-carrier");
  const selectOp = document.getElementById("movement-operation");

  if (selectUnidade) selectUnidade.value = "all";
  if (selectDestino) selectDestino.value = "all";
  if (selectEtapa) selectEtapa.value = "all";
  if (inputPlaca) inputPlaca.value = "";
  if (selectCarrier) selectCarrier.value = "all";
  if (selectOp) selectOp.value = "all";

  contextoInspecaoCard = null;

  if (Array.isArray(cacheTodosVeiculosAPI)) {
    veiculosAtivosAPI = cacheTodosVeiculosAPI;
  }

  renderMovements();
  carregarVeiculos({ destino: "all", etapa: "all" });
  notify(
    idiomaAtual === "en-US"
      ? "Movement filters cleared. Showing all active vehicles."
      : "Filtros de movimentação limpos. Exibindo todos os veículos ativos."
  );
}

function inspecionarAlertaPorPlaca(alertCard) {
  let placa = (alertCard?.dataset?.alertPlate || alertCard?.dataset?.placa || "").trim();
  if (!placa || placa === "—") {
    const match = alertCard?.textContent?.match(/[A-Z]{3}[0-9][A-Z0-9][0-9]{2}/i) || alertCard?.textContent?.match(/[A-Z]{3}-[0-9]{4}/i);
    if (match) placa = match[0].toUpperCase();
  }
  if (!placa || placa === "—") return;

  // Limpar qualquer seleção acidental de texto ao clicar
  try {
    const sel = window.getSelection();
    if (sel && typeof sel.removeAllRanges === "function") {
      sel.removeAllRanges();
    }
  } catch (e) {}

  const resumoAlerta = (alertCard.dataset?.alertSummary || alertCard.getAttribute?.("data-alert-summary") || "").trim();
  const selectUnidade = document.getElementById("movement-unidade");
  const selectDestino = document.getElementById("movement-destino");
  const selectEtapa = document.getElementById("movement-etapa");
  const inputPlaca = document.getElementById("plate-filter");
  const selectCarrier = document.getElementById("movement-carrier");
  const selectOp = document.getElementById("movement-operation");

  if (selectUnidade) selectUnidade.value = "all";
  if (selectDestino) selectDestino.value = "all";
  if (selectEtapa) selectEtapa.value = "all";
  if (selectCarrier) selectCarrier.value = "all";
  if (selectOp) selectOp.value = "all";
  if (inputPlaca) inputPlaca.value = placa;

  contextoInspecaoCard = {
    tipo: "Alerta Crítico",
    nome: resumoAlerta ? `Placa ${placa} — ${resumoAlerta}` : `Placa ${placa}`,
    totalVeiculos: 1,
    tempoOuPrancha: resumoAlerta || "Alerta ativo",
    volume: null,
    status: "CRITICO",
    ehAlerta: true
  };

  showPage("movements");
  renderMovements();

  // Scroll suave até o topo da tabela de movimentações
  const secaoTabela =
    document.getElementById("movement-table-container") ||
    document.querySelector(".tabela-movimentacoes__container") ||
    document.getElementById("page-movements");
  if (secaoTabela) {
    secaoTabela.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function inspecionarGrupoAreaPrimaria(groupFilter, tituloGrupo, tempoOuPrancha = "Monitoramento em tempo real", status = "NORMAL") {
  if (!groupFilter) return;

  const selectUnidade = document.getElementById("movement-unidade");
  const selectEtapa = document.getElementById("movement-etapa");
  const selectDestino = document.getElementById("movement-destino");
  const inputPlaca = document.getElementById("plate-filter");
  const selectCarrier = document.getElementById("movement-carrier");
  const selectOp = document.getElementById("movement-operation");

  const totalVeiculos = typeof obterFonteVeiculosCompleta === "function"
    ? obterFonteVeiculosCompleta().filter(v => pertenceAoGrupoAreaPrimaria(v.stage, groupFilter)).length
    : 0;

  contextoInspecaoCard = {
    tipo: "Área Primária",
    nome: tituloGrupo || groupFilter,
    filtroGrupo: groupFilter,
    etapasPermitidas: obterEtapasDoGrupoAreaPrimaria(groupFilter),
    totalVeiculos,
    tempoOuPrancha,
    status
  };

  if (selectUnidade) selectUnidade.value = "all";
  if (selectDestino) selectDestino.value = "all";
  if (selectEtapa) selectEtapa.value = "all";
  if (inputPlaca) inputPlaca.value = "";
  if (selectCarrier) selectCarrier.value = "all";
  if (selectOp) selectOp.value = "all";

  showPage("movements");
  renderMovements();
}

function inspecionarBercoOuDestino(bercoBruto, cardEl = null) {
  const bercoFiltro = normalizarRotuloDestino(bercoBruto) || bercoBruto;
  if (!bercoFiltro) return;

  const selectUnidade = document.getElementById("movement-unidade");
  const selectDestino = document.getElementById("movement-destino");
  const selectEtapa = document.getElementById("movement-etapa");
  const inputPlaca = document.getElementById("plate-filter");
  const selectCarrier = document.getElementById("movement-carrier");
  const selectOp = document.getElementById("movement-operation");

  if (selectUnidade) selectUnidade.value = "all";
  if (selectEtapa) selectEtapa.value = "all";
  if (inputPlaca) inputPlaca.value = "";
  if (selectCarrier) selectCarrier.value = "all";
  if (selectOp) selectOp.value = "all";

  if (selectDestino) {
    selecionarOpcaoEquivalente(selectDestino, bercoFiltro);
  }

  const cardReferencia = cardEl || document.querySelector(`.grade-bercos .berco[data-berco-filter="${bercoFiltro}"]`);
  contextoInspecaoCard = extrairResumoCardBerco(bercoFiltro, cardReferencia);
  showPage("movements");
  renderMovements();
}

document.addEventListener("click", event => {
  const btnClear = event.target.closest("[data-action='clear-movement-filters']");
  if (btnClear) {
    limparFiltrosMovimentacoes();
    return;
  }

  const btnEditHistory = event.target.closest("[data-action='view-alert-edit-history']");
  if (btnEditHistory) {
    event.stopPropagation();
    const placa = btnEditHistory.getAttribute("data-plate") || "";
    if (placa) {
      abrirModalHistoricoEdicaoAlerta(placa);
    }
    return;
  }

  const btnResolveAlert = event.target.closest("[data-action='resolve-alert']");
  if (btnResolveAlert) {
    event.stopPropagation();
    const chaveAlerta = btnResolveAlert.getAttribute("data-alert-key") || "";
    const alertaInfo = mapaAlertasRenderizados.get(chaveAlerta);
    if (alertaInfo) {
      abrirModalConfirmacaoResolucaoAlerta(alertaInfo);
    }
    return;
  }

  const btnRestaurarAlertas = event.target.closest("#btn-restaurar-alertas");
  if (btnRestaurarAlertas) {
    abrirModalRestaurarAlertas();
    return;
  }

  const alertCard = event.target.closest(".alertas__item");
  if (alertCard) {
    const placa = (alertCard.dataset.alertPlate || alertCard.dataset.placa || "").trim();
    const temMatch = placa || /[A-Z]{3}[0-9][A-Z0-9][0-9]{2}/i.test(alertCard.textContent) || /[A-Z]{3}-[0-9]{4}/i.test(alertCard.textContent);
    if (temMatch) {
      inspecionarAlertaPorPlaca(alertCard);
      return;
    }
  }

  const fluxoEtapaCard = event.target.closest(".fluxo-etapa--clicavel[data-fluxo-grupo]");
  if (fluxoEtapaCard) {
    const etapaId = fluxoEtapaCard.dataset.fluxoEtapa;
    const groupFilterOriginal = fluxoEtapaCard.dataset.fluxoGrupo;
    let groupFilter = groupFilterOriginal;
    let tituloPersonalizado = "";
    if (etapaId === "balanca") {
      groupFilter = "balanca_apenas";
      tituloPersonalizado = "6. Balança (Tara / Bruto)";
    } else if (etapaId === "pan_saida") {
      groupFilter = "pan_apenas";
      tituloPersonalizado = "7. PAN (Saída)";
    }

    const cardArea = document.querySelector(`.grade-esteira .esteira__etapa[data-group-filter="${groupFilterOriginal}"]`);
    const tituloGrupo =
      tituloPersonalizado ||
      cardArea?.querySelector(".card-area-primaria__titulo")?.textContent?.trim() ||
      fluxoEtapaCard.querySelector(".fluxo-etapa__nome")?.textContent?.trim() ||
      groupFilter;
    const tempoOuPrancha =
      cardArea?.querySelector(".esteira__tempo")?.textContent?.trim() || "Fluxo Convencional · COPI";
    const status =
      cardArea?.querySelector(".esteira__status")?.textContent?.trim() || "NORMAL";
    inspecionarGrupoAreaPrimaria(groupFilter, tituloGrupo, tempoOuPrancha, status);
    return;
  }

  const fluxoBercoEl = event.target.closest("[data-fluxo-berco]");
  if (fluxoBercoEl) {
    const bercoBruto = (fluxoBercoEl.dataset.fluxoBerco || "").trim();
    inspecionarBercoOuDestino(bercoBruto);
    return;
  }

  const etapaCard = event.target.closest(".esteira__etapa");
  if (etapaCard) {
    const selectUnidade = document.getElementById("movement-unidade");
    const selectEtapa = document.getElementById("movement-etapa");
    const selectDestino = document.getElementById("movement-destino");
    const inputPlaca = document.getElementById("plate-filter");
    const selectCarrier = document.getElementById("movement-carrier");
    const selectOp = document.getElementById("movement-operation");

    const groupFilter = etapaCard.dataset.groupFilter;
    if (groupFilter) {
      const tituloGrupo =
        etapaCard.querySelector(".card-area-primaria__titulo")?.textContent?.trim() ||
        etapaCard.querySelector("span")?.textContent?.trim() ||
        groupFilter;
      const tempoOuPrancha =
        etapaCard.querySelector(".esteira__tempo")?.textContent?.trim() || "Monitoramento em tempo real";
      const status =
        etapaCard.querySelector(".esteira__status")?.textContent?.trim() || "NORMAL";

      inspecionarGrupoAreaPrimaria(groupFilter, tituloGrupo, tempoOuPrancha, status);
      return;
    }

    const rawStage =
      etapaCard.dataset.stageFilter ||
      etapaCard.querySelector("span")?.textContent ||
      "";
    const etapaBruta = rawStage.replace(/^\d+\.\s*/, "").trim();
    const etapaFiltro = normalizarRotuloEtapa(etapaBruta) || etapaBruta;
    if (!etapaFiltro) return;

    if (selectUnidade) selectUnidade.value = "all";
    if (selectDestino) selectDestino.value = "all";
    if (inputPlaca) inputPlaca.value = "";
    if (selectCarrier) selectCarrier.value = "all";
    if (selectOp) selectOp.value = "all";

    if (selectEtapa) {
      selecionarOpcaoEquivalente(selectEtapa, etapaFiltro);
    }

    contextoInspecaoCard = extrairResumoCardEtapa(etapaFiltro, etapaCard);
    showPage("movements");
    renderMovements();
    return;
  }

  const bercoCard = event.target.closest(".berco");
  if (bercoCard) {
    const bercoBruto = (
      bercoCard.dataset.bercoFilter ||
      bercoCard.querySelector(".berco__titulo")?.textContent ||
      ""
    ).trim();
    inspecionarBercoOuDestino(bercoBruto, bercoCard);
  }
});

document.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const alertCard = event.target.closest(".alertas__item[data-alert-plate]");
  if (alertCard) {
    event.preventDefault();
    inspecionarAlertaPorPlaca(alertCard);
    return;
  }

  const fluxoEtapaCard = event.target.closest(".fluxo-etapa--clicavel[data-fluxo-grupo]");
  if (fluxoEtapaCard) {
    event.preventDefault();
    fluxoEtapaCard.click();
    return;
  }

  const fluxoBercoEl = event.target.closest(".fluxo-etapas--expedicao[data-fluxo-berco]");
  if (fluxoBercoEl) {
    event.preventDefault();
    fluxoBercoEl.click();
  }
});

/* =========================================
   SITUAÇÃO DOS VEÍCULOS
========================================= */

function statusBadge(status, possuiAlerta = false) {
  let className;
  const statusNorm = normalizarTexto(status);

  if (
    possuiAlerta ||
    statusNorm === "parado" ||
    statusNorm === "em alerta" ||
    statusNorm === "critico" ||
    statusNorm.includes("sobrepeso") ||
    statusNorm.includes("retencao")
  ) {
    className = "situacao--parado";
  } else if (statusNorm === "finalizado" || statusNorm === "concluido") {
    className = "situacao--concluido";
  } else {
    className = "situacao--andamento";
  }

  return `<span class="situacao ${className}">${escaparHtml(traduzirSituacao(status))}</span>`;
}

/* =========================================
   TABELAS DE MOVIMENTAÇÕES
========================================= */

function obterDescricaoFiltroAtivo() {
  const selectUnidade = document.getElementById("movement-unidade");
  const selectDestino = document.getElementById("movement-destino");
  const selectEtapa = document.getElementById("movement-etapa");
  const inputPlaca = document.getElementById("plate-filter");
  const selectCarrier = document.getElementById("movement-carrier");
  const selectOp = document.getElementById("movement-operation");

  const partes = [];
  if (selectUnidade && selectUnidade.value !== "all") {
    partes.push(`na unidade "${selectUnidade.value}"`);
  }
  if (selectDestino && selectDestino.value !== "all") {
    partes.push(`no destino "${selectDestino.value}"`);
  }
  if (selectEtapa && selectEtapa.value !== "all") {
    partes.push(`na etapa "${selectEtapa.value}"`);
  }
  if (inputPlaca && inputPlaca.value.trim()) {
    partes.push(`com a placa "${inputPlaca.value.trim().toUpperCase()}"`);
  }
  if (selectCarrier && selectCarrier.value !== "all") {
    partes.push(`da transportadora "${selectCarrier.value}"`);
  }
  if (selectOp && selectOp.value !== "all") {
    partes.push(`de "${selectOp.value}"`);
  }

  return partes.length > 0 ? partes.join(" ") : "nesta etapa/berço";
}

function formatarRotuloEtapaParaExibicao(item) {
  const etapaOriginal = item?.stage ?? "";
  const destinoBruto =
    item?.flow ?? item?.destino ?? item?.berco ?? item?.berco_destino ?? "";
  const operacaoBruta = item?.operation ?? item?.operacao ?? "";
  const ehExpedicao =
    coincidirDestino(destinoBruto, "Expedição") ||
    coincidirOperacao(operacaoBruta, "Expedição");
  if (!ehExpedicao) {
    return traduzirEtapa(etapaOriginal);
  }

  const etapaCanon = normalizarRotuloEtapa(etapaOriginal);
  if (etapaCanon === "Fila PRC" || etapaCanon === "Pátio") return "Gate in";
  if (etapaCanon === "Balança Tara") return "Balança (vazio)";
  if (etapaCanon === "Operação") return "Carregamento";
  if (etapaCanon === "Balança Bruto") return "Balança (carregado)";
  if (etapaCanon === "PAN") return "PAN (Acesso)";
  if (etapaCanon === "Gate-out") return "Gate out";

  return traduzirEtapa(etapaOriginal);
}

function formatarRotuloAlertaParaExibicao(item, badge) {
  const rotulo = badge?.rotulo ?? "";
  if (!rotulo) return "";
  const ehExpedicao = coincidirDestino(
    item?.flow ?? item?.destino ?? item?.berco ?? item?.berco_destino ?? "",
    "Expedição"
  );
  if (!ehExpedicao) return rotulo;

  if (
    badge?.tipo === "RETENCAO_PRC" ||
    /reten[çc][ãa]o\s*prc/i.test(rotulo) ||
    /prc\s*retention/i.test(rotulo)
  ) {
    return rotulo
      .replace(/Reten[çc][ãa]o\s*PRC/gi, "Retenção Gate in")
      .replace(/PRC\s*Retention/gi, "Gate in Retention");
  }
  return rotulo;
}

function renderMovementRows(list, targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;

  if (!list.length) {
    const descFiltro = obterDescricaoFiltroAtivo();
    const emptyMsg =
      idiomaAtual === "en-US"
        ? t("movements.empty_filtered")
        : `<strong>Nenhum veículo detalhado ${escaparHtml(descFiltro)} no momento</strong> — clique em "Limpar filtros" para ver todos os veículos ativos.`;
    target.innerHTML = `
      <tr>
        <td colspan="9" class="tabela__linha-vazia">
          <div class="tabela__vazia-conteudo">
            <p>${emptyMsg}</p>
            <button type="button" class="botao botao--claro" data-action="clear-movement-filters">
              ${escaparHtml(t("movements.clear_filters"))}
            </button>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const mostrarValor = valor => {
    return valor === null || valor === undefined || valor === ""
      ? "—"
      : escaparHtml(valor);
  };

  const formatarPesoExibicao = (item, alertaInfo) => {
    let pesoBruto =
      item.peso_kg ??
      item.peso_liquido ??
      item.peso_bruto ??
      item.PesoLiquido ??
      item.PesoCheio ??
      item.peso ??
      item.netWeight ??
      item.grossWeight ??
      item.tareWeight ??
      null;
    if (
      (pesoBruto === null || pesoBruto === undefined || pesoBruto === "" || pesoBruto === "—") &&
      alertaInfo?.tipo === "SOBREPESO" &&
      alertaInfo?.excessoKg > 0
    ) {
      pesoBruto = 48500 + Number(alertaInfo.excessoKg);
    }
    if (pesoBruto === null || pesoBruto === undefined || pesoBruto === "" || pesoBruto === "—") {
      return "—";
    }
    if (typeof pesoBruto === "number") {
      return `${escaparHtml(formatarNumero(pesoBruto, 0))} kg`;
    }
    const texto = String(pesoBruto).trim();
    if (/\bkg$/i.test(texto)) {
      return escaparHtml(texto);
    }
    return `${escaparHtml(texto)} kg`;
  };

  const placasLocaisSet = new Set(
    veiculosCadastradosLocalmente.map(v => normalizarTexto(v.plate))
  );

  target.innerHTML = list
    .map(item => {
      const alertaInfo = resolverAlertaVeiculo(item);
      const temAlerta = alertaInfo.temAlerta;
      const classeLinha = temAlerta
        ? "tabela__linha--parado tabela__linha--alerta"
        : "";
      const chave = obterChaveRegistroVeiculo(item);
      const isLocal =
        item.origem === "local" || placasLocaisSet.has(normalizarTexto(item.plate));

      const etapaCanon = normalizarRotuloEtapa(item.stage);
      const statusNorm = normalizarTexto(item.status);
      const situacaoOperacional =
        etapaCanon === "Gate-out" || statusNorm === "finalizado" || statusNorm === "concluido"
          ? "Finalizado"
          : "Em trânsito";
      const badgeSituacaoOperacional = statusBadge(situacaoOperacional, false);
      const badgesAlertaHtml = (alertaInfo.badges || [])
        .map(b => `<span class="${b.classeBadge}">${escaparHtml(formatarRotuloAlertaParaExibicao(item, b))}</span>`)
        .join("");
      const edicoesPlaca = obterEdicoesAlertaPorPlaca(item.plate);
      const badgeEditadoMovimentacaoHtml =
        edicoesPlaca.length > 0
          ? `<button type="button" class="badge-editado-movimentacao" data-action="view-alert-edit-history" data-plate="${escaparHtml(item.plate)}" title="${
              idiomaAtual === "en-US" ? "View alert edit history" : "Ver histórico de edição do alerta"
            }">✎ ${idiomaAtual === "en-US" ? "Edited" : "Editado"}</button>`
          : "";
      const badgeSituacao = `
        <div class="celula-situacao-alertas">
          ${badgeSituacaoOperacional}
          ${badgesAlertaHtml}
          ${badgeEditadoMovimentacaoHtml}
        </div>
      `;

      return `
        <tr class="${classeLinha}">
          <td>
            <button
              type="button"
              class="link-placa-ticket"
              data-ticket-plate="${escaparHtml(item.plate)}"
              title="${escaparHtml(t("movements.plate_tooltip"))}"
            >
              ${mostrarValor(item.plate)}
            </button>
          </td>
          <td>${mostrarValor(item.carrier)}</td>
          <td>${mostrarValor(traduzirOperacao(item.operation))}</td>
          <td>${mostrarValor(traduzirDestino(item.flow))}</td>
          <td>${mostrarValor(formatarRotuloEtapaParaExibicao(item))}</td>
          <td>${formatarPesoExibicao(item, alertaInfo)}</td>
          <td>${mostrarValor(item.duration)}</td>
          <td>${badgeSituacao}</td>
          <td>
            <button
              type="button"
              class="btn-remover-registro"
              data-remove-key="${escaparHtml(chave)}"
              data-remove-plate="${escaparHtml(item.plate)}"
              data-remove-carrier="${escaparHtml(item.carrier || "")}"
              data-remove-local="${isLocal ? "true" : "false"}"
              title="${escaparHtml(t("movements.remove_aria", { plate: item.plate }))}"
            >
              ${escaparHtml(t("movements.remove_btn"))}
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
}

/* =========================================
   MODAL DE DETALHES DO TICKET IPORT (COPI001)
========================================= */

function formatarDocumentoLote(item) {
  const tipo = String(item.tipoDocumentoLote ?? item.TipoDocumentoLote ?? "").trim();
  const num = String(
    item.numeroDocumentoLote ?? item.NumeroDocumentoLote ?? item.bl ?? "—"
  ).trim();
  if (!num || num === "—") return tipo || "—";
  if (!tipo || num.toUpperCase().startsWith(tipo.toUpperCase())) return num;
  return `${tipo} ${num}`;
}

function formatarPesoTicketKg(item) {
  const bruto =
    item.pesoMovimentadoKg ??
    item.PesoMovimentado ??
    item.pesoNumerico ??
    converterPesoParaNumero(item.netWeight ?? item.grossWeight ?? item.tareWeight);
  if (bruto === null || bruto === undefined || Number.isNaN(Number(bruto))) {
    return "—";
  }
  return `${formatarNumero(Number(bruto), 0)} kg`;
}

let veiculoModalTicketAtual = null;

function gerarResumoTextoTicket(veiculo) {
  if (!veiculo) return "";
  const ticket = veiculo.ticket ?? veiculo.Ticket ?? "MOV-2026-00001";
  const placa = veiculo.plate ?? veiculo.Placa ?? "—";
  const unidade = veiculo.unidade ?? veiculo.NomeEmpresa ?? "COPISI";
  const transportadora = veiculo.carrier ?? veiculo.NomeTransportadora ?? "—";
  const documentoLote = formatarDocumentoLote(veiculo);
  const pesoMovimentado = formatarPesoTicketKg(veiculo);

  const rotuloTicket = "Ticket";
  const rotuloPlaca = idiomaAtual === "en-US" ? "Plate" : "Placa";

  return `${rotuloTicket} ${ticket} | ${rotuloPlaca} ${placa} | ${unidade} | ${transportadora} | ${documentoLote} | ${pesoMovimentado}`;
}

async function copiarResumoTicketModal() {
  if (!veiculoModalTicketAtual) return;
  const texto = gerarResumoTextoTicket(veiculoModalTicketAtual);
  if (!texto) return;

  let copiado = false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(texto);
      copiado = true;
    } catch (e) {
      // fallback abaixo
    }
  }

  if (!copiado) {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = texto;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.select();
      copiado = document.execCommand("copy");
      document.body.removeChild(textarea);
    } catch (e) {
      console.warn("Falha ao copiar resumo do ticket:", e);
    }
  }

  const btn = document.getElementById("ticket-modal-copy-summary");
  if (btn) {
    btn.textContent = t("ticket.copied");
    clearTimeout(btn._timerCopiar);
    btn._timerCopiar = setTimeout(() => {
      btn.textContent = t("ticket.copy_summary");
    }, 2000);
  }
}

function abrirModalDetalhesTicket(placaAlvo) {
  const modal = document.getElementById("ticket-details-modal");
  const bodyEl = document.getElementById("ticket-modal-body");
  if (!modal || !bodyEl) return;

  const placaNorm = normalizarTexto(placaAlvo);
  const veiculo = obterFonteVeiculosCompleta().find(
    v => normalizarTexto(v.plate ?? v.Placa) === placaNorm
  );
  if (!veiculo) return;

  veiculoModalTicketAtual = veiculo;
  const copyBtn = document.getElementById("ticket-modal-copy-summary");
  if (copyBtn) {
    clearTimeout(copyBtn._timerCopiar);
    copyBtn.textContent = t("ticket.copy_summary");
  }

  const ticket = veiculo.ticket ?? veiculo.Ticket ?? "MOV-2026-00001";
  const statusTicket = veiculo.statusTicket ?? veiculo.Status ?? "1 - Ativo";
  const unidade = veiculo.unidade ?? veiculo.NomeEmpresa ?? "COPISI";
  const tipoMovimentacao =
    veiculo.tipoMovimentacao ??
    veiculo.TipoMovimentacao ??
    (coincidirOperacao(veiculo.operation, "Expedição") ? "Saída" : "Entrada");
  const placa = veiculo.plate ?? veiculo.Placa ?? "—";
  const motorista = veiculo.driver ?? veiculo.NomeMotorista ?? "—";
  const transportadora = veiculo.carrier ?? veiculo.NomeTransportadora ?? "—";
  const cliente = veiculo.cliente ?? veiculo.NomeCliente ?? "—";
  const referencia = veiculo.referencia ?? veiculo.Referencia ?? veiculo.ship ?? "—";
  const documentoLote = formatarDocumentoLote(veiculo);
  const localFisico = veiculo.localFisico ?? veiculo.Local ?? veiculo.flow ?? "—";
  const dataMovimentacao =
    veiculo.dataMovimentacao ?? veiculo.DataMovimentacao ?? veiculo.entryPAN ?? "—";
  const pesoMovimentado = formatarPesoTicketKg(veiculo);

  const classeStatusTicket = String(statusTicket).startsWith("2")
    ? "situacao situacao--andamento"
    : "situacao situacao--concluido";

  bodyEl.innerHTML = `
    <div class="modal-ticket__topo-resumo">
      <div class="modal-ticket__codigo">
        <small>Ticket iPort (COPI001)</small>
        <strong>${escaparHtml(ticket)}</strong>
      </div>
      <div class="modal-ticket__badges">
        <span class="modal-ticket__status-pill ${classeStatusTicket}">${escaparHtml(statusTicket)}</span>
        <span class="modal-ticket__unidade-pill">${escaparHtml(unidade)}</span>
      </div>
    </div>

    <div class="modal-ticket__grade">
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.unit"))} (NomeEmpresa)</span>
        <strong>${escaparHtml(unidade)}</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.operation"))}</span>
        <strong>${escaparHtml(traduzirOperacao(tipoMovimentacao))} (${escaparHtml(traduzirOperacao(veiculo.operation || "Operação"))})</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.plate"))}</span>
        <strong>${escaparHtml(placa)}</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.driver"))} (NomeMotorista)</span>
        <strong>${escaparHtml(motorista)}</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.carrier"))} (NomeTransportadora)</span>
        <strong>${escaparHtml(transportadora)}</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.client"))} (NomeCliente)</span>
        <strong>${escaparHtml(cliente)}</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.vessel"))} (Referencia)</span>
        <strong>${escaparHtml(referencia)}</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.doc"))}</span>
        <strong>${escaparHtml(documentoLote)}</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.dest"))} (Local)</span>
        <strong>${escaparHtml(traduzirDestino(localFisico))}</strong>
      </div>
      <div class="modal-ticket__campo">
        <span>${escaparHtml(t("ticket_modal.stay"))} (DataMovimentacao)</span>
        <strong>${escaparHtml(dataMovimentacao)}</strong>
      </div>
      <div class="modal-ticket__campo modal-ticket__campo--largo">
        <span>${escaparHtml(t("ticket_modal.net"))} (PesoMovimentado)</span>
        <strong>${escaparHtml(pesoMovimentado)}</strong>
      </div>
    </div>
  `;

  if (typeof modal.showModal === "function") {
    if (!modal.open) {
      modal.showModal();
    }
  } else {
    modal.setAttribute("open", "");
  }
}

function fecharModalDetalhesTicket() {
  const modal = document.getElementById("ticket-details-modal");
  if (!modal) return;
  const copyBtn = document.getElementById("ticket-modal-copy-summary");
  if (copyBtn) {
    clearTimeout(copyBtn._timerCopiar);
    copyBtn.textContent = t("ticket.copy_summary");
  }
  if (typeof modal.close === "function" && modal.open) {
    modal.close();
  } else {
    modal.removeAttribute("open");
  }
}

/* =========================================
   FILTROS DAS MOVIMENTAÇÕES (REATIVIDADE)
========================================= */

function deduplicarVeiculos(lista = []) {
  const chavesVistas = new Set();
  return (Array.isArray(lista) ? lista : []).filter(item => {
    const chave = obterChaveRegistroVeiculo(item) || normalizarTexto(item?.plate);
    if (!chave) return true;
    if (chavesVistas.has(chave)) return false;
    chavesVistas.add(chave);
    return true;
  });
}

function aplicarEdicoesAlertasEmVeiculos(lista = []) {
  const arr = Array.isArray(lista) ? lista : [];
  const chavesEditadas = Object.keys(alertasEditadosLocal || {});
  if (!chavesEditadas.length) return arr;

  const limiteSobrepeso = Number(configOperacionalCCO?.limiteSobrepesoKg) || 48500;

  return arr.map(item => {
    const placaNorm = normalizarTexto(item?.plate ?? item?.placa ?? "");
    if (!placaNorm) return item;

    const sufixo = `::${placaNorm}`;
    const chavesDaPlaca = chavesEditadas.filter(k => k.endsWith(sufixo));
    if (!chavesDaPlaca.length) return item;

    let atualizado = { ...item };
    chavesDaPlaca.forEach(chave => {
      const edicao = alertasEditadosLocal[chave];
      if (!edicao) return;

      if (edicao.etapa && edicao.etapa !== "—") {
        atualizado.stage = edicao.etapa;
        atualizado.etapa = edicao.etapa;
      }

      if (edicao.valorAtual && edicao.valorAtual !== "—") {
        const ehPeso =
          chave.startsWith("SOBREPESO::") || /\bkg\b/i.test(edicao.valorAtual);
        const ehTempo =
          chave.startsWith("RETENCAO_PRC::") || /\bmin\b/i.test(edicao.valorAtual);

        if (ehPeso) {
          const pesoEditado = converterPesoParaNumero(edicao.valorAtual);
          if (pesoEditado !== null) {
            atualizado.grossWeight = pesoEditado;
            atualizado.peso_bruto_kg = pesoEditado;
            atualizado.peso_bruto = pesoEditado;
            atualizado.peso_kg = pesoEditado;
            atualizado.pesoNumerico = pesoEditado;
            atualizado.peso = pesoEditado;
            atualizado.excesso_peso_kg =
              pesoEditado > limiteSobrepeso ? pesoEditado - limiteSobrepeso : 0;
            atualizado.sobrepeso = pesoEditado > limiteSobrepeso;
            atualizado._pesoEditadoManualmente = true;
          }
        } else if (ehTempo) {
          const matchMin = String(edicao.valorAtual)
            .replace(/\./g, "")
            .match(/(\d+(?:[.,]\d+)?)/);
          if (matchMin) {
            const mins = Number(matchMin[1].replace(",", "."));
            if (Number.isFinite(mins)) {
              atualizado.durationMin = mins;
              atualizado.tempo_permanencia = mins;
              atualizado.duration = `${formatarNumero(mins, 0)} min`;
              atualizado._tempoEditadoManualmente = true;
            }
          }
        }
      }
    });

    return atualizado;
  });
}

function obterFonteVeiculosCompleta() {
  if (Array.isArray(cacheTodosVeiculosAPI) && cacheTodosVeiculosAPI.length > 0) {
    return aplicarEdicoesAlertasEmVeiculos(
      deduplicarVeiculos(mesclarVeiculosComLocais(cacheTodosVeiculosAPI))
    );
  }
  if (Array.isArray(veiculosAtivosAPI) && veiculosAtivosAPI.length > 0) {
    return aplicarEdicoesAlertasEmVeiculos(
      deduplicarVeiculos(mesclarVeiculosComLocais(veiculosAtivosAPI))
    );
  }
  return aplicarEdicoesAlertasEmVeiculos(
    deduplicarVeiculos(mesclarVeiculosComLocais(movements))
  );
}

function filteredMovements() {
  const unidadeSelect = document.getElementById("movement-unidade");
  const plateInput = document.getElementById("plate-filter");
  const carrierSelect = document.getElementById("movement-carrier");
  const operationSelect = document.getElementById("movement-operation");
  const destinoSelect = document.getElementById("movement-destino");
  const etapaSelect = document.getElementById("movement-etapa");

  const unidade = unidadeSelect ? unidadeSelect.value : "all";
  const plate = normalizarTexto(plateInput ? plateInput.value : "");
  const carrier = carrierSelect ? carrierSelect.value : "all";
  const operation = operationSelect ? operationSelect.value : "all";
  const destino = destinoSelect ? destinoSelect.value : "all";
  const etapa = etapaSelect ? etapaSelect.value : "all";

  const base = obterFonteVeiculosCompleta();

  const filtrados = base.filter(item => {
    const itemUnidade = item.unidade ?? item.NomeEmpresa ?? "COPISI";
    const matchUnidade =
      !unidade ||
      unidade === "all" ||
      normalizarTexto(itemUnidade) === normalizarTexto(unidade);
    const matchPlate = !plate || normalizarTexto(item.plate).includes(plate);
    const matchCarrier =
      !carrier ||
      carrier === "all" ||
      normalizarTexto(item.carrier) === normalizarTexto(carrier);
    const matchOperation = coincidirOperacao(item.operation, operation);
    const matchDestino = coincidirDestino(item.flow, destino);

    let matchEtapa = true;
    if (contextoInspecaoCard?.filtroGrupo) {
      matchEtapa = pertenceAoGrupoAreaPrimaria(item.stage, contextoInspecaoCard.filtroGrupo);
    } else {
      matchEtapa = coincidirEtapa(item.stage, etapa);
    }

    return (
      matchUnidade &&
      matchPlate &&
      matchCarrier &&
      matchOperation &&
      matchDestino &&
      matchEtapa
    );
  });

  return deduplicarVeiculos(filtrados);
}

function atualizarBotaoRestaurarRemovidos() {
  const qtd = historicoVeiculosExcluidos.length;
  const btn = document.getElementById("btn-restaurar-removidos");
  if (!btn) return;
  if (qtd > 0) {
    btn.hidden = false;
    btn.textContent =
      idiomaAtual === "en-US"
        ? `Restore deleted (${qtd})`
        : `Restaurar excluídos (${qtd})`;
  } else {
    btn.hidden = true;
  }
}

function renderMovements(origemAPI = false) {
  atualizarBannerInspecaoMovimentacoes();

  const list = filteredMovements();
  renderMovementRows(list, "movement-rows");
  atualizarBotaoRestaurarRemovidos();

  const countEl = document.getElementById("movement-count");
  if (countEl) {
    const temDadosAPI =
      origemAPI ||
      (Array.isArray(cacheTodosVeiculosAPI) && cacheTodosVeiculosAPI.length > 0) ||
      apiConectada;
    const sufixo = temDadosAPI ? "da operação" : "demonstrativo(s)";
    countEl.textContent = `${list.length} registro(s) ${sufixo} encontrado(s)`;
  }
}

async function runMovementSearch(buscarRemoto = false) {
  renderMovements();

  if (buscarRemoto) {
    await carregarVeiculos();
  }
}

const btnClearMovements = document.getElementById("clear-movements-filters");
if (btnClearMovements) {
  btnClearMovements.addEventListener("click", limparFiltrosMovimentacoes);
}

const inputPlateFilter = document.getElementById("plate-filter");
if (inputPlateFilter) {
  inputPlateFilter.addEventListener("input", () => {
    if (contextoInspecaoCard?.ehAlerta && !inputPlateFilter.value.trim()) {
      contextoInspecaoCard = null;
    }
    renderMovements();
  });
  inputPlateFilter.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      runMovementSearch(true);
    }
  });
}

const selectMovementUnidade = document.getElementById("movement-unidade");
if (selectMovementUnidade) {
  selectMovementUnidade.addEventListener("change", () => renderMovements());
}

const selectMovementDestino = document.getElementById("movement-destino");
if (selectMovementDestino) {
  selectMovementDestino.addEventListener("change", () => {
    contextoInspecaoCard = null;
    renderMovements();
  });
}

const selectMovementEtapa = document.getElementById("movement-etapa");
if (selectMovementEtapa) {
  selectMovementEtapa.addEventListener("change", () => {
    contextoInspecaoCard = null;
    renderMovements();
  });
}

const selectMovementCarrier = document.getElementById("movement-carrier");
if (selectMovementCarrier) {
  selectMovementCarrier.addEventListener("change", () => {
    contextoInspecaoCard = null;
    renderMovements();
  });
}

const selectMovementOperation = document.getElementById("movement-operation");
if (selectMovementOperation) {
  selectMovementOperation.addEventListener("change", () => renderMovements());
}

/* =========================================
   PAINEL E ABA DE TRANSPORTADORAS (REATIVOS · COPI001)
========================================= */

function calcularEstatisticasTransportadoras(
  filtroOperacao = "all",
  filtroPeriodo = "today",
  filtroUnidade = "all",
  termoBusca = ""
) {
  const todosVeiculos = obterFonteVeiculosCompleta();
  const termoNorm = normalizarTexto(termoBusca);

  const veiculosFiltrados = todosVeiculos.filter(v => {
    const itemUnidade = String(v.unidade ?? v.NomeEmpresa ?? "COPISI").toUpperCase();
    const matchUnidade =
      !filtroUnidade ||
      filtroUnidade === "all" ||
      normalizarTexto(itemUnidade) === normalizarTexto(filtroUnidade);
    const matchOp = coincidirOperacao(v.operation, filtroOperacao);
    const nomeCarrier = v.carrier && v.carrier !== "—" ? v.carrier : "Outras";
    const matchBusca = !termoNorm || normalizarTexto(nomeCarrier).includes(termoNorm);
    return matchUnidade && matchOp && matchBusca;
  });

  const fatorPeriodo =
    filtroPeriodo === "48h"
      ? 2
      : filtroPeriodo === "24h"
      ? 1.2
      : filtroPeriodo === "30d"
      ? 18
      : filtroPeriodo === "7d"
      ? 5
      : 1;

  const mapa = new Map();
  carriersBase.forEach(c => {
    mapa.set(c.name, {
      name: c.name,
      count: 0,
      rawCount: 0,
      totalMinutes: 0,
      totalWeightKg: 0,
      unidadesSet: new Set(),
      temCritico: false,
      temAtencao: false,
      motivosCriticos: new Set(),
      prancha: c.prancha
    });
  });

  veiculosFiltrados.forEach(v => {
    const nome = v.carrier && v.carrier !== "—" ? v.carrier : "Outras";
    if (!mapa.has(nome)) {
      mapa.set(nome, {
        name: nome,
        count: 0,
        rawCount: 0,
        totalMinutes: 0,
        totalWeightKg: 0,
        unidadesSet: new Set(),
        temCritico: false,
        temAtencao: false,
        motivosCriticos: new Set(),
        prancha: "65 t/h"
      });
    }
    const item = mapa.get(nome);
    const durMin = Number(v.durationMin) || extrairMinutosDeTexto(v.duration) || 48;
    const pesoKg = obterPesoNumericoVeiculoRelatorio(v);
    const unid = String(v.unidade ?? v.NomeEmpresa ?? "COPISI").toUpperCase();
    const alertaInfo = resolverAlertaVeiculo(v);

    item.rawCount += 1;
    item.count += 1 * fatorPeriodo;
    item.totalMinutes += durMin * fatorPeriodo;
    item.totalWeightKg += pesoKg * fatorPeriodo;
    item.unidadesSet.add(unid);

    if (alertaInfo.temAlerta) {
      item.temCritico = true;
      (alertaInfo.badges || []).forEach(b => {
        if (b.nivel === "critico") {
          item.motivosCriticos.add(
            b.tipo === "SOBREPESO"
              ? "Sobrepeso"
              : b.tipo === "RETENCAO_PRC"
              ? "Retenção PRC"
              : "Alerta Crítico"
          );
        }
      });
    } else if (alertaInfo.temAtencao) {
      item.temAtencao = true;
    }
  });

  const lista = Array.from(mapa.values())
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count);

  const totalVeiculos = lista.reduce((acc, item) => acc + item.count, 0);
  const somaMinutos = lista.reduce((acc, item) => acc + item.totalMinutes, 0);
  const somaPesoKg = lista.reduce((acc, item) => acc + item.totalWeightKg, 0);
  const tempoMedioGeral = totalVeiculos > 0 ? Math.round(somaMinutos / totalVeiculos) : 0;

  const linhas = lista.map(item => {
    const percentual = totalVeiculos > 0 ? Math.round((item.count / totalVeiculos) * 100) : 0;
    const tempoMedio = item.count > 0 ? Math.round(item.totalMinutes / item.count) : 45;
    const unidades = Array.from(item.unidadesSet);
    const pesoTon = item.totalWeightKg / 1000;

    let statusSLA = "Regular";
    let classeSLA = "situacao situacao--concluido";
    let detalheSLA = "";

    if (item.temCritico) {
      statusSLA = "Crítico";
      classeSLA = "situacao situacao--parado";
      detalheSLA = Array.from(item.motivosCriticos).join(" · ");
    } else if (item.temAtencao || tempoMedio >= 75) {
      statusSLA = "Atenção SLA";
      classeSLA = "badge badge--atencao";
    }

    return {
      name: item.name,
      count: item.count,
      rawCount: item.rawCount,
      percent: percentual,
      avgTimeMin: tempoMedio,
      avgTime: `${tempoMedio} min`,
      totalWeightKg: item.totalWeightKg,
      totalWeightTon: pesoTon,
      unidades,
      statusSLA,
      classeSLA,
      detalheSLA,
      prancha: item.prancha
    };
  });

  const qtdCriticas = linhas.filter(l => l.statusSLA === "Crítico").length;

  return {
    linhas,
    totalTransportadoras: linhas.length,
    totalVeiculos,
    somaPesoKg,
    somaPesoTon: somaPesoKg / 1000,
    tempoMedioGeral,
    qtdCriticas
  };
}

function ajustarPercentuaisMaiorResto(itens) {
  if (!Array.isArray(itens) || itens.length === 0) return [];
  const total = itens.reduce((acc, it) => acc + (it.count || 0), 0);
  if (total === 0) {
    return itens.map(it => ({ ...it, percent: 0 }));
  }

  const comRestos = itens.map((it, idx) => {
    const exato = ((it.count || 0) / total) * 100;
    const inteiro = Math.floor(exato);
    return {
      index: idx,
      item: it,
      inteiro,
      resto: exato - inteiro
    };
  });

  const somaInteiros = comRestos.reduce((acc, r) => acc + r.inteiro, 0);
  const falta = Math.max(0, 100 - somaInteiros);

  const indicesOrdenados = [...comRestos]
    .sort((a, b) => b.resto - a.resto)
    .slice(0, falta)
    .map(r => r.index);

  const setBonus = new Set(indicesOrdenados);

  return comRestos.map(r => {
    const percentualFinal = r.inteiro + (setBonus.has(r.index) ? 1 : 0);
    return {
      ...r.item,
      percent: percentualFinal
    };
  });
}

function gerarGradienteDonutTransportadoras(itens) {
  if (!itens || itens.length === 0) return "var(--cor-grafico-cinza)";
  const totalContagem = itens.reduce((acc, it) => acc + (it.count || 0), 0);
  if (totalContagem === 0) return "var(--cor-grafico-cinza)";

  const cores = [
    "var(--cor-grafico-azul)",
    "var(--cor-grafico-verde)",
    "var(--cor-grafico-laranja)",
    "var(--cor-grafico-roxo)",
    "var(--cor-grafico-cinza)"
  ];

  let acumulado = 0;
  const segmentos = itens.map((item, idx) => {
    const cor = cores[idx % cores.length];
    const inicio = acumulado;
    acumulado += item.percent;
    const fim = idx === itens.length - 1 ? 100 : Math.min(100, acumulado);
    return `${cor} ${inicio}% ${fim}%`;
  });

  return `conic-gradient(${segmentos.join(", ")})`;
}

function atualizarPainelTransportadorasOverview() {
  const stats = calcularEstatisticasTransportadoras("all", "today", "all", "");
  const totalStrong = document.querySelector(".distribuicao__grafico strong");
  const legendaContainer = document.querySelector(".painel--transportadoras .legenda");
  const graficoEl = document.querySelector(".distribuicao__grafico");

  let linhasComPercent = [];
  if (stats.linhas && stats.linhas.length > 0) {
    const topCarriers = stats.linhas.slice(0, 5);
    linhasComPercent = ajustarPercentuaisMaiorResto(topCarriers);
  }

  const totalVeiculosOperacao = stats.totalVeiculos;
  if (totalStrong && totalVeiculosOperacao !== undefined) {
    totalStrong.textContent = totalVeiculosOperacao;
  }

  if (graficoEl) {
    if (linhasComPercent.length > 0 && (totalVeiculosOperacao || 0) > 0) {
      graficoEl.style.background = gerarGradienteDonutTransportadoras(linhasComPercent);
      const rotuloVeiculos = idiomaAtual === "en-US" ? "vehicles" : "veículos";
      const tooltipDonut = linhasComPercent
        .map(item => `${item.name}: ${item.count} ${rotuloVeiculos} (${item.percent}%)`)
        .join("\n");
      graficoEl.setAttribute("title", tooltipDonut);
    } else {
      graficoEl.style.background = "var(--cor-grafico-cinza)";
      graficoEl.removeAttribute("title");
    }
  }

  if (legendaContainer && linhasComPercent.length > 0) {
    const cores = [
      "legenda__ponto--azul",
      "legenda__ponto--verde-agua",
      "legenda__ponto--laranja",
      "legenda__ponto--roxo",
      "legenda__ponto--cinza"
    ];

    legendaContainer.innerHTML = linhasComPercent
      .map((item, idx) => {
        const cor = cores[idx % cores.length] || "legenda__ponto--cinza";
        const rotuloVeiculos = idiomaAtual === "en-US" ? "vehicles" : "veículos";
        const tooltipItem = `${item.name}: ${item.count} ${rotuloVeiculos} (${item.percent}%)`;
        return `
          <span title="${escaparHtml(tooltipItem)}">
            <i class="legenda__ponto ${cor}"></i>
            ${escaparHtml(item.name)} — <b>${item.count} (${item.percent}%)</b>
          </span>
        `;
      })
      .join("");
  }
}

function renderCarriers() {
  const carrierRows = document.getElementById("carrier-rows");
  if (!carrierRows) return;

  const unidadeSelect = document.getElementById("carrier-unidade");
  const searchInput = document.getElementById("carrier-search-input");
  const periodSelect = document.getElementById("carrier-period");
  const operationSelect = document.getElementById("carrier-operation");

  const unidade = unidadeSelect ? unidadeSelect.value : "all";
  const termoBusca = searchInput ? searchInput.value.trim() : "";
  const periodo = periodSelect ? periodSelect.value : "today";
  const operacao = operationSelect ? operationSelect.value : "all";

  const stats = calcularEstatisticasTransportadoras(operacao, periodo, unidade, termoBusca);

  const kpiTotal = document.getElementById("carrier-kpi-total");
  const kpiObs = document.getElementById("carrier-kpi-obs");
  const kpiVehicles = document.getElementById("carrier-kpi-vehicles");
  const kpiVolume = document.getElementById("carrier-kpi-volume");
  const kpiTime = document.getElementById("carrier-kpi-time");
  const kpiSla = document.getElementById("carrier-kpi-sla");
  const subtitle = document.getElementById("carrier-table-subtitle");

  if (kpiTotal) kpiTotal.textContent = stats.totalTransportadoras;
  if (kpiObs) {
    kpiObs.textContent =
      unidade === "all"
        ? idiomaAtual === "en-US"
          ? "Active across COPISI, VM & TIPA"
          : "Ativas em COPISI, VM e TIPA"
        : idiomaAtual === "en-US"
        ? `Active in unit ${unidade}`
        : `Ativas na unidade ${unidade}`;
  }
  if (kpiVehicles) kpiVehicles.textContent = formatarNumero(stats.totalVeiculos);
  if (kpiVolume) {
    kpiVolume.textContent =
      idiomaAtual === "en-US"
        ? `Total volume: ${formatarNumero(stats.somaPesoKg, 0)} kg (${formatarNumero(stats.somaPesoTon, 1)} t)`
        : `Volume total: ${formatarNumero(stats.somaPesoKg, 0)} kg (${formatarNumero(stats.somaPesoTon, 1)} t)`;
  }
  if (kpiTime) kpiTime.innerHTML = `${stats.tempoMedioGeral} <small>min</small>`;
  if (kpiSla) {
    kpiSla.textContent =
      stats.qtdCriticas > 0
        ? t("carriers.kpi_sla_crit", { n: stats.qtdCriticas })
        : idiomaAtual === "en-US"
        ? "All within operational SLA"
        : "Todas dentro do SLA operacional";
  }
  if (subtitle) {
    const rotuloUnid =
      unidade === "all"
        ? t("filter.unit_all")
        : idiomaAtual === "en-US"
        ? `Unit ${unidade}`
        : `Unidade ${unidade}`;
    const rotuloOp = operacao === "all" ? t("filter.all_fem") : traduzirOperacao(operacao);
    subtitle.textContent = t("carriers.panel_subtitle_filtered", {
      n: stats.linhas.length,
      unit: rotuloUnid,
      op: rotuloOp
    });
  }

  if (!stats.linhas.length) {
    carrierRows.innerHTML = `
      <tr>
        <td colspan="7" class="tabela__linha-vazia">
          ${escaparHtml(t("carriers.empty"))}
        </td>
      </tr>
    `;
    return;
  }

  carrierRows.innerHTML = stats.linhas
    .map(row => {
      const badgesUnidades = row.unidades
        .map(u => `<span class="situacao situacao--andamento">${escaparHtml(u)}</span>`)
        .join(" ");
      const volumeTexto =
        row.totalWeightKg > 0
          ? `<strong>${escaparHtml(formatarNumero(row.totalWeightKg, 0))} kg</strong> <small>(${escaparHtml(formatarNumero(row.totalWeightTon, 1))} t)</small>`
          : "—";

      return `
        <tr>
          <td class="tabela__nome-transportadora">${escaparHtml(row.name)}</td>
          <td><strong>${escaparHtml(formatarNumero(row.count))}</strong> <small>(${escaparHtml(row.percent)}%)</small></td>
          <td>${volumeTexto}</td>
          <td>${escaparHtml(row.avgTime)}</td>
          <td><div class="celula-unidades-badges">${badgesUnidades}</div></td>
          <td>
            <div class="celula-situacao-alertas">
              <span class="${row.classeSLA}">${escaparHtml(traduzirSituacao(row.statusSLA))}</span>
              ${row.detalheSLA ? `<small class="sla-detalhe-critico">${escaparHtml(row.detalheSLA)}</small>` : ""}
            </div>
          </td>
          <td>
            <button
              type="button"
              class="botao botao--claro botao--ver-veiculos"
              data-carrier-goto="${escaparHtml(row.name)}"
              title="${escaparHtml(t("carriers.view_vehicles"))} (${escaparHtml(row.name)})"
            >
              ${escaparHtml(t("carriers.view_vehicles"))}
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
}

const selectCarrierUnidade = document.getElementById("carrier-unidade");
if (selectCarrierUnidade) {
  selectCarrierUnidade.addEventListener("change", renderCarriers);
}

const inputCarrierSearch = document.getElementById("carrier-search-input");
if (inputCarrierSearch) {
  inputCarrierSearch.addEventListener("input", renderCarriers);
}

const selectCarrierPeriod = document.getElementById("carrier-period");
if (selectCarrierPeriod) {
  selectCarrierPeriod.addEventListener("change", renderCarriers);
}

const selectCarrierOperation = document.getElementById("carrier-operation");
if (selectCarrierOperation) {
  selectCarrierOperation.addEventListener("change", renderCarriers);
}

const carrierRowsTableEl = document.getElementById("carrier-rows");
if (carrierRowsTableEl) {
  carrierRowsTableEl.addEventListener("click", event => {
    const btnGoto = event.target.closest("[data-carrier-goto]");
    if (!btnGoto) return;
    const nomeTransportadora = btnGoto.dataset.carrierGoto || "";
    if (!nomeTransportadora) return;

    const selectUnidadeCarrier = document.getElementById("carrier-unidade");
    const selectOpCarrier = document.getElementById("carrier-operation");

    const selectUnidadeMov = document.getElementById("movement-unidade");
    const selectDestinoMov = document.getElementById("movement-destino");
    const selectEtapaMov = document.getElementById("movement-etapa");
    const inputPlacaMov = document.getElementById("plate-filter");
    const selectCarrierMov = document.getElementById("movement-carrier");
    const selectOpMov = document.getElementById("movement-operation");

    if (selectUnidadeMov) {
      selectUnidadeMov.value = selectUnidadeCarrier ? selectUnidadeCarrier.value : "all";
    }
    if (selectDestinoMov) selectDestinoMov.value = "all";
    if (selectEtapaMov) selectEtapaMov.value = "all";
    if (inputPlacaMov) inputPlacaMov.value = "";
    if (selectOpMov) {
      selectOpMov.value = selectOpCarrier ? selectOpCarrier.value : "all";
    }
    if (selectCarrierMov) {
      selecionarOpcaoEquivalente(selectCarrierMov, nomeTransportadora);
    }

    contextoInspecaoCard = {
      tipo: "Transportadora",
      nome: nomeTransportadora,
      totalVeiculos: 0,
      tempoOuPrancha: `Transportadora: ${nomeTransportadora}`,
      volume: null,
      status: "ATIVO",
      ehTransportadora: true
    };
    showPage("movements");
    renderMovements();
  });
}

/* =========================================
   EXPORTAR CSV
========================================= */

const btnExportCsv = document.getElementById("export-csv");
if (btnExportCsv) {
  btnExportCsv.addEventListener("click", () => {
    const header = [
      "Placa",
      "Navio",
      "Fluxo",
      "Janela",
      "BL",
      "Motorista",
      "Transportadora",
      "Entrada PAN",
      "Eixos",
      "Peso Tara",
      "Data Tara",
      "Data Coletor",
      "Peso Cheio",
      "Peso Líquido",
      "Data Cheio",
      "Sobrepeso",
      "Saída",
      "Duração",
      "Etapa",
      "Situação"
    ];

    const rows = [
      header,
      ...filteredMovements().map(item => [
        item.plate,
        item.ship,
        item.flow,
        item.window,
        item.bl,
        item.driver,
        item.carrier,
        item.entryPAN,
        item.axles,
        item.tareWeight,
        item.tareDate,
        item.collectorDate,
        item.grossWeight,
        item.netWeight,
        item.grossDate,
        item.overweight,
        item.exit,
        item.duration,
        item.stage,
        item.status
      ])
    ];

    const formatarValor = valor => {
      return valor === null || valor === undefined || valor === "" ? "—" : valor;
    };

    const csv =
      "\uFEFF" +
      rows
        .map(row =>
          row
            .map(value => `"${String(formatarValor(value)).replaceAll('"', '""')}"`)
            .join(";")
        )
        .join("\r\n");

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "movimentacoes-cco.csv";

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    notify("Arquivo CSV exportado com sucesso.");
  });
}

/* =========================================
   FILTROS E AÇÕES DOS RELATÓRIOS (COPI001)
========================================= */

let relatorioModalAtual = null;

function obterFiltrosRelatoriosAtuais() {
  const selectPeriod = document.getElementById("report-period");
  const selectUnidade = document.getElementById("report-unidade");
  const selectType = document.getElementById("report-type");

  const periodo = selectPeriod ? selectPeriod.value : "today";
  const unidade = selectUnidade ? selectUnidade.value : "all";
  const tipo = selectType ? selectType.value : "all";

  const rotulosPeriodo = {
    today: idiomaAtual === "en-US" ? "Today" : "Hoje",
    "24h": idiomaAtual === "en-US" ? "Last 24h" : "Últimas 24h",
    "48h": idiomaAtual === "en-US" ? "Last 48h" : "Últimas 48h",
    "7d": idiomaAtual === "en-US" ? "Last 7 days" : "Últimos 7 dias",
    "30d": idiomaAtual === "en-US" ? "Last 30 days" : "Últimos 30 dias"
  };

  const rotuloUnidade =
    unidade === "all"
      ? (idiomaAtual === "en-US" ? "All units" : "Todas as unidades")
      : unidade;

  return {
    periodo,
    rotuloPeriodo: rotulosPeriodo[periodo] || rotulosPeriodo.today,
    unidade,
    rotuloUnidade,
    tipo
  };
}

function obterPesoNumericoVeiculoRelatorio(item) {
  const bruto =
    item.pesoMovimentadoKg ??
    item.PesoMovimentado ??
    item.pesoNumerico ??
    converterPesoParaNumero(item.netWeight ?? item.grossWeight ?? item.tareWeight);
  const num = Number(bruto);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function ehMovimentacaoEntradaRelatorio(item) {
  const tipoMov = normalizarTexto(item.tipoMovimentacao ?? item.TipoMovimentacao);
  if (tipoMov === "entrada") return true;
  if (tipoMov === "saida") return false;
  return coincidirOperacao(item.operation, "Recebimento");
}

function ehMovimentacaoSaidaRelatorio(item) {
  const tipoMov = normalizarTexto(item.tipoMovimentacao ?? item.TipoMovimentacao);
  if (tipoMov === "saida") return true;
  if (tipoMov === "entrada") return false;
  return coincidirOperacao(item.operation, "Expedição");
}

function obterVeiculosFiltradosRelatorio(unidadeFiltro = "all") {
  const todos = obterFonteVeiculosCompleta();
  return todos.filter(item => {
    const itemUnidade = String(item.unidade ?? item.NomeEmpresa ?? "COPISI")
      .trim()
      .toUpperCase();
    return (
      !unidadeFiltro ||
      unidadeFiltro === "all" ||
      normalizarTexto(itemUnidade) === normalizarTexto(unidadeFiltro)
    );
  });
}

function construirEstoqueConsolidadoRelatorio(veiculosBase) {
  const mapa = new Map();

  veiculosBase.forEach(item => {
    const unidade = String(item.unidade ?? item.NomeEmpresa ?? "COPISI")
      .trim()
      .toUpperCase();
    const localBox = String(item.localFisico ?? item.Local ?? item.flow ?? "Pátio Geral").trim();
    const cliente = String(item.cliente ?? item.NomeCliente ?? "Cliente Operação Portuária").trim();
    const chave = `${normalizarTexto(unidade)}|${normalizarTexto(localBox)}|${normalizarTexto(cliente)}`;

    if (!mapa.has(chave)) {
      mapa.set(chave, {
        unidade,
        localBox,
        cliente,
        qtdMovimentacoes: 0,
        volumeTotalKg: 0
      });
    }

    const grupo = mapa.get(chave);
    grupo.qtdMovimentacoes += 1;
    grupo.volumeTotalKg += obterPesoNumericoVeiculoRelatorio(item);
  });

  return Array.from(mapa.values()).sort((a, b) => b.volumeTotalKg - a.volumeTotalKg);
}

const MAPA_MANIFESTADO_PADRAO = {
  "26/0410101-1": 47000,
  "26/0410102-0": 46500,
  "BL-ITQ-2026-103": 47000,
  "26/0410104-6": 47000,
  "26/0410105-4": 47000,
  "BL-ITQ-2026-106": 48500,
  "26/0410107-0": 48500,
  "BL-ITQ-2026-108": 48000,
  "BL-ITQ-2026-109": 48000,
  "BL-ITQ-2026-202": 47500,
  "BL-ITQ-2026-205": 48500,
  "26/0630301-5": 48500,
  "BL-ITQ-2026-302": 47500,
  "26/0630303-1": 48000,
  "BL-ITQ-2026-304": 47000,
  "26/0630305-8": 48000,
  "BL-ITQ-2026-401": 48000,
  "26/0740402-3": 47000,
  "BL-ITQ-2026-403": 47000,
  "26/0740404-0": 48500,
  "BL-ITQ-2026-405": 48000
};

function construirConferenciaManifestadoRealizadoRelatorio(veiculosBase) {
  const mapa = new Map();

  veiculosBase.forEach(item => {
    const unidade = String(item.unidade ?? item.NomeEmpresa ?? "COPISI")
      .trim()
      .toUpperCase();
    const cliente = String(item.cliente ?? item.NomeCliente ?? "Cliente Operação Portuária").trim();
    const tipoDoc = String(item.tipoDocumentoLote ?? item.TipoDocumentoLote ?? "").trim();
    const numDoc = String(
      item.numeroDocumentoLote ?? item.NumeroDocumentoLote ?? item.bl ?? ""
    ).trim();
    const loteFormatado = formatarDocumentoLote(item);
    const chave = `${normalizarTexto(unidade)}|${normalizarTexto(loteFormatado)}|${normalizarTexto(cliente)}`;

    const pesoItemRealizado = obterPesoNumericoVeiculoRelatorio(item);
    const manifestoDireto = converterPesoParaNumero(
      item.pesoManifestadoKg ?? item.PesoManifestadoKg ?? item.peso_manifestado_kg
    );

    if (!mapa.has(chave)) {
      let volumeManifestado = 0;
      if (manifestoDireto && manifestoDireto > 0) {
        volumeManifestado = manifestoDireto;
      } else if (numDoc && MAPA_MANIFESTADO_PADRAO[numDoc]) {
        volumeManifestado = MAPA_MANIFESTADO_PADRAO[numDoc];
      }

      mapa.set(chave, {
        unidade,
        cliente,
        tipoDocumentoLote: tipoDoc || "—",
        numeroDocumentoLote: numDoc || "—",
        loteFormatado: loteFormatado || "—",
        qtdMovimentacoes: 0,
        volumeRealizadoKg: 0,
        volumeManifestadoKg: volumeManifestado
      });
    }

    const grupo = mapa.get(chave);
    grupo.qtdMovimentacoes += 1;
    grupo.volumeRealizadoKg += pesoItemRealizado;

    if (manifestoDireto && manifestoDireto > grupo.volumeManifestadoKg) {
      grupo.volumeManifestadoKg = manifestoDireto;
    }
  });

  const grupos = Array.from(mapa.values()).map(g => {
    if (!g.volumeManifestadoKg || g.volumeManifestadoKg <= 0) {
      g.volumeManifestadoKg = Math.max(48000, Math.ceil(g.volumeRealizadoKg / 10000) * 10000);
    }

    const saldoRestanteKg = g.volumeManifestadoKg - g.volumeRealizadoKg;
    const pctExecutado =
      g.volumeManifestadoKg > 0 ? (g.volumeRealizadoKg / g.volumeManifestadoKg) * 100 : 0;
    const noTetoOuExcedente = pctExecutado >= 100;

    let statusTeto = "";
    let classeBadge = "";
    let classeLinha = "";

    if (pctExecutado > 100) {
      const excessoKg = g.volumeRealizadoKg - g.volumeManifestadoKg;
      statusTeto =
        idiomaAtual === "en-US"
          ? `Exceeded (+${formatarNumero(excessoKg, 0)} kg)`
          : `Excedente (+${formatarNumero(excessoKg, 0)} kg)`;
      classeBadge = "badge badge--critico";
      classeLinha = "tabela__linha--parado tabela__linha--alerta";
    } else if (pctExecutado === 100) {
      statusTeto = idiomaAtual === "en-US" ? "Ceiling reached (100%)" : "Teto atingido (100%)";
      classeBadge = "badge badge--alerta";
      classeLinha = "tabela__linha--parado tabela__linha--alerta";
    } else if (pctExecutado >= 90) {
      statusTeto =
        idiomaAtual === "en-US"
          ? `Near ceiling (${formatarNumero(pctExecutado, 1)}%)`
          : `Próximo ao teto (${formatarNumero(pctExecutado, 1)}%)`;
      classeBadge = "badge badge--atencao";
      classeLinha = "";
    } else {
      statusTeto =
        idiomaAtual === "en-US"
          ? `Within limit (${formatarNumero(pctExecutado, 1)}%)`
          : `Normal (${formatarNumero(pctExecutado, 1)}%)`;
      classeBadge = "situacao situacao--concluido";
      classeLinha = "";
    }

    return {
      ...g,
      saldoRestanteKg,
      pctExecutado,
      noTetoOuExcedente,
      statusTeto,
      classeBadge,
      classeLinha
    };
  });

  return grupos.sort((a, b) => b.pctExecutado - a.pctExecutado);
}

function aplicarFiltroRelatorios() {
  const { tipo } = obterFiltrosRelatoriosAtuais();

  document.querySelectorAll(".relatorio").forEach(card => {
    card.hidden = tipo !== "all" && card.dataset.type !== tipo;
  });

  atualizarSubtitulosRelatorios();
}

function atualizarSubtitulosRelatorios() {
  const { unidade, rotuloUnidade, rotuloPeriodo } = obterFiltrosRelatoriosAtuais();
  const baseFiltrada = obterVeiculosFiltradosRelatorio(unidade);
  const listaRec = baseFiltrada.filter(ehMovimentacaoEntradaRelatorio);
  const listaExp = baseFiltrada.filter(ehMovimentacaoSaidaRelatorio);
  const estoqueGrupos = construirEstoqueConsolidadoRelatorio(baseFiltrada);

  const pesoTotalKg = baseFiltrada.reduce(
    (acc, item) => acc + obterPesoNumericoVeiculoRelatorio(item),
    0
  );
  const pesoTotalTon = pesoTotalKg / 1000;

  const alertasQtd = baseFiltrada.filter(v => resolverAlertaVeiculo(v).temAlerta).length;

  document.querySelectorAll(".relatorio").forEach(card => {
    const tipo = card.dataset.type;
    const small = card.querySelector("small");
    if (!small) return;

    if (tipo === "Movimentação de carga") {
      small.textContent = t("reports.count_records", {
        n: baseFiltrada.length,
        vol: formatarNumero(pesoTotalTon, 1),
        unit: rotuloUnidade
      });
    } else if (tipo === "Recebimento de carga") {
      const qtdVM = listaRec.filter(
        v => String(v.unidade ?? v.NomeEmpresa ?? "").toUpperCase() === "VM"
      ).length;
      small.textContent =
        idiomaAtual === "en-US"
          ? `${listaRec.length} inbound (${rotuloUnidade}) · COPI001 VM: ${qtdVM} record(s)`
          : `${listaRec.length} entrada(s) (${rotuloUnidade} · ${rotuloPeriodo}) · Destaque COPI001: ${qtdVM} registro(s) na unidade VM`;
    } else if (tipo === "Expedição de carga") {
      small.textContent =
        idiomaAtual === "en-US"
          ? `${listaExp.length} outbound (${rotuloUnidade}) · Units: COPISI, VM & TIPA`
          : `${listaExp.length} saída(s) (${rotuloUnidade} · ${rotuloPeriodo}) · Unidades: COPISI, VM e TIPA`;
    } else if (tipo === "Estoque atual") {
      small.textContent = t("reports.count_stock", {
        n: estoqueGrupos.length,
        vol: formatarNumero(pesoTotalTon, 1),
        unit: rotuloUnidade
      });
    } else if (tipo === "Conferência de Manifestado × Realizado") {
      const lotesGrupos = construirConferenciaManifestadoRealizadoRelatorio(baseFiltrada);
      const lotesCriticos = lotesGrupos.filter(g => g.pctExecutado >= 100).length;
      small.textContent = t("reports.count_manifest_vs_actual", {
        n: lotesGrupos.length,
        alertas: lotesCriticos,
        unit: rotuloUnidade
      });
    } else if (tipo === "Relatório de veículos") {
      small.textContent =
        idiomaAtual === "en-US"
          ? `${baseFiltrada.length} vehicle(s) (${rotuloUnidade}) · ${alertasQtd} critical alert(s)`
          : `${baseFiltrada.length} veículo(s) no recorte (${rotuloUnidade}) · ${alertasQtd} alerta(s) crítico(s)`;
    }
  });
}

function exportarRelatorioCSV(tipoRelatorio, linhas = [], colunas = []) {
  const formatarCelulaCSV = valor => {
    const texto =
      valor === null || valor === undefined || valor === "" ? "—" : String(valor);
    return `"${texto.replaceAll('"', '""')}"`;
  };

  const todasLinhas = [colunas, ...linhas];
  const conteudoCSV =
    "\uFEFF" +
    todasLinhas.map(linha => linha.map(formatarCelulaCSV).join(";")).join("\r\n");

  const blob = new Blob([conteudoCSV], {
    type: "text/csv;charset=utf-8;"
  });

  const slug =
    normalizarTexto(tipoRelatorio || "relatorio-operacional").replace(/\s+/g, "-") ||
    "relatorio-operacional";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}-copi001.csv`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(
    t("reports.csv_exported", {
      title: tipoRelatorio,
      n: linhas.length
    })
  );
}

function construirDadosRelatorio(tipoRelatorio) {
  const { unidade, rotuloUnidade, rotuloPeriodo } = obterFiltrosRelatoriosAtuais();
  const baseUnidade = obterVeiculosFiltradosRelatorio(unidade);

  let veiculosRecorte = baseUnidade;
  if (tipoRelatorio === "Recebimento de carga") {
    veiculosRecorte = baseUnidade.filter(ehMovimentacaoEntradaRelatorio);
  } else if (tipoRelatorio === "Expedição de carga") {
    veiculosRecorte = baseUnidade.filter(ehMovimentacaoSaidaRelatorio);
  }

  const pesoTotalKg = veiculosRecorte.reduce(
    (acc, v) => acc + obterPesoNumericoVeiculoRelatorio(v),
    0
  );
  const pesoTotalTon = pesoTotalKg / 1000;

  const somaMinutos = veiculosRecorte.reduce(
    (acc, v) => acc + (Number(v.durationMin) || extrairMinutosDeTexto(v.duration) || 45),
    0
  );
  const tempoMedioMin =
    veiculosRecorte.length > 0 ? Math.round(somaMinutos / veiculosRecorte.length) : 0;

  const totalAlertas = veiculosRecorte.filter(v => resolverAlertaVeiculo(v).temAlerta).length;

  let colunas = [];
  let linhasCSV = [];
  let linhasHTML = "";
  let notaContextual = "";
  let totalRegistrosExibidos = veiculosRecorte.length;

  if (
    tipoRelatorio === "Movimentação de carga" ||
    tipoRelatorio === "Recebimento de carga" ||
    tipoRelatorio === "Expedição de carga"
  ) {
    colunas = [
      "Ticket",
      "Unidade",
      "Tipo",
      "Placa",
      "Motorista",
      "Transportadora",
      "Cliente",
      "Lote",
      "Local",
      "Peso (kg)"
    ];

    if (tipoRelatorio === "Recebimento de carga") {
      notaContextual =
        "Regra operacional COPI001 (Recebimento de Carga): A unidade VM opera exclusivamente fluxos de Entrada (descarga rodoviária com pesagem e vinculação de DI/BL), ao lado das entradas de COPISI e TIPA.";
    } else if (tipoRelatorio === "Expedição de carga") {
      notaContextual =
        "Contrato COPI001 (Expedição de Carga): Detalhamento dos registros de Saída (carregamento e expedição) nas unidades COPISI, VM e TIPA.";
    } else {
      notaContextual =
        "Contrato COPI001 (Movimentação de Carga): Visão completa dos tickets ativos (1 - Ativo) e alterados (2 - Alterado) de Entrada e Saída.";
    }

    linhasCSV = veiculosRecorte.map(v => {
      const ticket = v.ticket ?? v.Ticket ?? "—";
      const unid = v.unidade ?? v.NomeEmpresa ?? "COPISI";
      const tipoMov =
        v.tipoMovimentacao ??
        v.TipoMovimentacao ??
        (ehMovimentacaoSaidaRelatorio(v) ? "Saída" : "Entrada");
      const placa = v.plate ?? v.Placa ?? "—";
      const motorista = v.driver ?? v.NomeMotorista ?? "—";
      const transportadora = v.carrier ?? v.NomeTransportadora ?? "—";
      const cliente = v.cliente ?? v.NomeCliente ?? "—";
      const lote = formatarDocumentoLote(v);
      const local = v.localFisico ?? v.Local ?? v.flow ?? "—";
      const pesoKgNum = obterPesoNumericoVeiculoRelatorio(v);
      const pesoFormatado = pesoKgNum > 0 ? formatarNumero(pesoKgNum, 0) : "—";

      return [
        ticket,
        unid,
        tipoMov,
        placa,
        motorista,
        transportadora,
        cliente,
        lote,
        local,
        pesoFormatado
      ];
    });

    linhasHTML = veiculosRecorte
      .map(v => {
        const ticket = v.ticket ?? v.Ticket ?? "—";
        const unid = String(v.unidade ?? v.NomeEmpresa ?? "COPISI").toUpperCase();
        const tipoMov =
          v.tipoMovimentacao ??
          v.TipoMovimentacao ??
          (ehMovimentacaoSaidaRelatorio(v) ? "Saída" : "Entrada");
        const placa = v.plate ?? v.Placa ?? "—";
        const motorista = v.driver ?? v.NomeMotorista ?? "—";
        const transportadora = v.carrier ?? v.NomeTransportadora ?? "—";
        const cliente = v.cliente ?? v.NomeCliente ?? "—";
        const lote = formatarDocumentoLote(v);
        const local = v.localFisico ?? v.Local ?? v.flow ?? "—";
        const pesoKgNum = obterPesoNumericoVeiculoRelatorio(v);
        const pesoFormatado = pesoKgNum > 0 ? `${formatarNumero(pesoKgNum, 0)} kg` : "—";

        const badgeUnidadeClasse = "badge-unidade";
        const badgeTipoClasse =
          normalizarTexto(tipoMov) === "saida"
            ? "situacao situacao--andamento"
            : "situacao situacao--concluido";

        return `
          <tr>
            <th scope="row">${escaparHtml(ticket)}</th>
            <td><span class="${badgeUnidadeClasse}">${escaparHtml(unid)}</span></td>
            <td><span class="${badgeTipoClasse}">${escaparHtml(tipoMov)}</span></td>
            <td><strong>${escaparHtml(placa)}</strong></td>
            <td>${escaparHtml(motorista)}</td>
            <td>${escaparHtml(transportadora)}</td>
            <td>${escaparHtml(cliente)}</td>
            <td>${escaparHtml(lote)}</td>
            <td>${escaparHtml(local)}</td>
            <td><strong>${escaparHtml(pesoFormatado)}</strong></td>
          </tr>
        `;
      })
      .join("");
  } else if (tipoRelatorio === "Estoque atual") {
    const grupos = construirEstoqueConsolidadoRelatorio(veiculosRecorte);
    totalRegistrosExibidos = grupos.length;

    colunas = [
      "Unidade",
      "Local / Box",
      "Cliente",
      "Qtd. Movimentações",
      "Volume Total (kg)",
      "Volume Total (t)"
    ];

    notaContextual =
      "Consolidação de Estoque Atual (COPI001): Agrupamento físico e contábil por Unidade + Local/Box + Cliente com soma de movimentações e volume total movimentado.";

    linhasCSV = grupos.map(g => [
      g.unidade,
      g.localBox,
      g.cliente,
      g.qtdMovimentacoes,
      formatarNumero(g.volumeTotalKg, 0),
      formatarNumero(g.volumeTotalKg / 1000, 2)
    ]);

    linhasHTML = grupos
      .map(
        g => `
        <tr>
          <th scope="row"><span class="badge-unidade">${escaparHtml(g.unidade)}</span></th>
          <td>${escaparHtml(g.localBox)}</td>
          <td><strong>${escaparHtml(g.cliente)}</strong></td>
          <td>${escaparHtml(formatarNumero(g.qtdMovimentacoes, 0))}</td>
          <td>${escaparHtml(formatarNumero(g.volumeTotalKg, 0))} kg</td>
          <td><strong>${escaparHtml(formatarNumero(g.volumeTotalKg / 1000, 2))} t</strong></td>
        </tr>
      `
      )
      .join("");
  } else if (tipoRelatorio === "Conferência de Manifestado × Realizado") {
    const lotesGrupos = construirConferenciaManifestadoRealizadoRelatorio(veiculosRecorte);
    totalRegistrosExibidos = lotesGrupos.length;

    const pesoManifestadoTotalKg = lotesGrupos.reduce((acc, g) => acc + g.volumeManifestadoKg, 0);
    const pesoRealizadoTotalKg = lotesGrupos.reduce((acc, g) => acc + g.volumeRealizadoKg, 0);
    const lotesCriticos = lotesGrupos.filter(g => g.pctExecutado >= 100).length;

    colunas =
      idiomaAtual === "en-US"
        ? [
            "Unit",
            "Client",
            "Doc Type",
            "Doc / Batch No.",
            "Vehicles Qty",
            "Manifested Vol (kg)",
            "Actual Vol (kg)",
            "Remaining Balance (kg)",
            "% Executed",
            "Status / Ceiling"
          ]
        : [
            "Unidade",
            "Cliente",
            "Tipo Doc.",
            "Nº Lote / Documento",
            "Qtd. Veículos",
            "Vol. Manifestado (kg)",
            "Vol. Realizado (kg)",
            "Saldo Restante (kg)",
            "% Executado",
            "Situação / Teto"
          ];

    notaContextual =
      idiomaAtual === "en-US"
        ? "Ceiling Control (COPI001 Manifested vs. Actual): Cross-references manifested weight against executed volume per Batch/Document and Client across COPISI, VM, and TIPA units. Highlighting operational ceilings (>= 100%) for CCO intervention."
        : "Controle de Teto Operacional (COPI001 Manifestado × Realizado): Cruzamento contábil entre peso manifestado e volume efetivamente realizado por Lote/Documento e Cliente nas unidades COPISI, VM e TIPA. Alerta de teto (>= 100%) para interrupção e validação do CCO.";

    linhasCSV = lotesGrupos.map(g => [
      g.unidade,
      g.cliente,
      g.tipoDocumentoLote,
      g.numeroDocumentoLote,
      g.qtdMovimentacoes,
      formatarNumero(g.volumeManifestadoKg, 0),
      formatarNumero(g.volumeRealizadoKg, 0),
      formatarNumero(g.saldoRestanteKg, 0),
      `${formatarNumero(g.pctExecutado, 1)}%`,
      g.statusTeto
    ]);

    linhasHTML = lotesGrupos
      .map(
        g => `
        <tr class="${g.classeLinha}">
          <th scope="row"><span class="badge-unidade">${escaparHtml(g.unidade)}</span></th>
          <td><strong>${escaparHtml(g.cliente)}</strong></td>
          <td>${escaparHtml(g.tipoDocumentoLote)}</td>
          <td><code>${escaparHtml(g.numeroDocumentoLote)}</code></td>
          <td>${escaparHtml(formatarNumero(g.qtdMovimentacoes, 0))}</td>
          <td>${escaparHtml(formatarNumero(g.volumeManifestadoKg, 0))} kg</td>
          <td><strong>${escaparHtml(formatarNumero(g.volumeRealizadoKg, 0))} kg</strong></td>
          <td style="${g.saldoRestanteKg < 0 ? "color: var(--cor-erro, #e74c61); font-weight: 700;" : ""}">
            ${escaparHtml(formatarNumero(g.saldoRestanteKg, 0))} kg
          </td>
          <td><strong>${escaparHtml(formatarNumero(g.pctExecutado, 1))}%</strong></td>
          <td><span class="${g.classeBadge}">${escaparHtml(g.statusTeto)}</span></td>
        </tr>
      `
      )
      .join("");

    return {
      tipoRelatorio,
      rotuloUnidade,
      rotuloPeriodo,
      totalRegistros: totalRegistrosExibidos,
      pesoTotalKg: pesoRealizadoTotalKg,
      pesoTotalTon: pesoRealizadoTotalKg / 1000,
      pesoManifestadoTotalKg,
      lotesCriticos,
      tempoMedioMin,
      totalAlertas: lotesCriticos,
      colunas,
      linhasCSV,
      linhasHTML,
      notaContextual
    };
  } else {
    // Relatório de veículos
    colunas = [
      "Placa",
      "Unidade",
      "Etapa Atual",
      "Permanência (min)",
      "Peso (kg)",
      "Situação / Alertas"
    ];

    notaContextual =
      "Relatório Operacional de Veículos: Monitoramento de etapa do fluxo operacional / Área Primária, tempo de permanência (min), peso movimentado e alertas críticos.";

    linhasCSV = veiculosRecorte.map(v => {
      const placa = v.plate ?? v.Placa ?? "—";
      const unid = v.unidade ?? v.NomeEmpresa ?? "COPISI";
      const etapa = v.stage || "—";
      const permMin = Number(v.durationMin) || extrairMinutosDeTexto(v.duration) || 0;
      const pesoKgNum = obterPesoNumericoVeiculoRelatorio(v);
      const pesoFormatado = pesoKgNum > 0 ? formatarNumero(pesoKgNum, 0) : "—";
      const alertaInfo = resolverAlertaVeiculo(v);
      const situacaoTexto =
        alertaInfo.badges && alertaInfo.badges.length > 0
          ? `${v.status || "Em operação"} (${alertaInfo.badges.map(b => b.rotulo).join(", ")})`
          : v.status || "Em operação";

      return [placa, unid, etapa, permMin, pesoFormatado, situacaoTexto];
    });

    linhasHTML = veiculosRecorte
      .map(v => {
        const placa = v.plate ?? v.Placa ?? "—";
        const unid = v.unidade ?? v.NomeEmpresa ?? "COPISI";
        const etapa = v.stage || "—";
        const permMin = Number(v.durationMin) || extrairMinutosDeTexto(v.duration) || 0;
        const pesoKgNum = obterPesoNumericoVeiculoRelatorio(v);
        const pesoFormatado = pesoKgNum > 0 ? `${formatarNumero(pesoKgNum, 0)} kg` : "—";
        const alertaInfo = resolverAlertaVeiculo(v);
        const classeLinha = alertaInfo.temAlerta
          ? "tabela__linha--parado tabela__linha--alerta"
          : "";
        const badgeSituacao = statusBadge(v.status || "Em operação", false);
        const badgesAlerta = (alertaInfo.badges || [])
          .map(b => `<span class="${b.classeBadge}">${escaparHtml(b.rotulo)}</span>`)
          .join(" ");

        return `
          <tr class="${classeLinha}">
            <th scope="row">${escaparHtml(placa)}</th>
            <td><span class="badge-unidade">${escaparHtml(unid)}</span></td>
            <td>${escaparHtml(etapa)}</td>
            <td>${escaparHtml(formatarNumero(permMin, 0))} min</td>
            <td>${escaparHtml(pesoFormatado)}</td>
            <td>
              <div class="celula-situacao-alertas">
                ${badgeSituacao}
                ${badgesAlerta}
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  return {
    tipoRelatorio,
    rotuloUnidade,
    rotuloPeriodo,
    totalRegistros: totalRegistrosExibidos,
    pesoTotalKg,
    pesoTotalTon,
    tempoMedioMin,
    totalAlertas,
    colunas,
    linhasCSV,
    linhasHTML,
    notaContextual
  };
}

function abrirModalDetalhesRelatorio(tipoRelatorio) {
  const modal = document.getElementById("report-details-modal");
  const titleEl = document.getElementById("report-modal-title");
  const badgesEl = document.getElementById("report-modal-badges");
  const kpisEl = document.getElementById("report-modal-kpis");
  const noteEl = document.getElementById("report-modal-note");
  const tableEl = document.getElementById("report-modal-table");
  const theadEl = document.getElementById("report-modal-thead");
  const tbodyEl = document.getElementById("report-modal-tbody");

  if (!modal || !theadEl || !tbodyEl) return;

  const dados = construirDadosRelatorio(tipoRelatorio);
  relatorioModalAtual = {
    tipoRelatorio: dados.tipoRelatorio,
    linhasCSV: dados.linhasCSV,
    colunas: dados.colunas
  };

  if (titleEl) {
    titleEl.textContent = dados.tipoRelatorio;
  }

  if (badgesEl) {
    badgesEl.innerHTML = `
      <span class="situacao situacao--andamento">${idiomaAtual === "en-US" ? "Unit: " : "Unidade: "}${escaparHtml(dados.rotuloUnidade)}</span>
      <span class="situacao situacao--concluido">${idiomaAtual === "en-US" ? "Period: " : "Período: "}${escaparHtml(dados.rotuloPeriodo)}</span>
    `;
  }

  if (kpisEl) {
    if (dados.tipoRelatorio === "Conferência de Manifestado × Realizado") {
      const lotesCriticos = dados.lotesCriticos ?? 0;
      kpisEl.innerHTML = `
        <div class="modal-relatorio__kpi">
          <span>${idiomaAtual === "en-US" ? "Total Batches / Lots" : "Total de Lotes / Docs"}</span>
          <strong>${escaparHtml(formatarNumero(dados.totalRegistros, 0))}</strong>
          <small>${idiomaAtual === "en-US" ? "Monitored lots in query" : "Lotes monitorados no recorte"}</small>
        </div>
        <div class="modal-relatorio__kpi">
          <span>${idiomaAtual === "en-US" ? "Total Manifested" : "Volume Manifestado Total"}</span>
          <strong>${escaparHtml(formatarNumero(dados.pesoManifestadoTotalKg || 0, 0))} kg</strong>
          <small>${escaparHtml(formatarNumero((dados.pesoManifestadoTotalKg || 0) / 1000, 2))} t</small>
        </div>
        <div class="modal-relatorio__kpi">
          <span>${idiomaAtual === "en-US" ? "Total Executed / Actual" : "Volume Realizado Total"}</span>
          <strong>${escaparHtml(formatarNumero(dados.pesoTotalKg, 0))} kg</strong>
          <small>${escaparHtml(formatarNumero(dados.pesoTotalTon, 2))} t</small>
        </div>
        <div class="modal-relatorio__kpi ${lotesCriticos > 0 ? "modal-relatorio__kpi--critico" : ""}">
          <span>${idiomaAtual === "en-US" ? "Ceiling Alert (>= 100%)" : "Alerta de Teto (>= 100%)"}</span>
          <strong>${escaparHtml(formatarNumero(lotesCriticos, 0))}</strong>
          <small>${lotesCriticos > 0 ? (idiomaAtual === "en-US" ? "Intervention / validation required" : "Interrupção / validação do CCO") : (idiomaAtual === "en-US" ? "All lots within limit" : "Todos os lotes dentro da cota")}</small>
        </div>
      `;
    } else {
      kpisEl.innerHTML = `
        <div class="modal-relatorio__kpi">
          <span>${idiomaAtual === "en-US" ? "Total records" : "Total de registros"}</span>
          <strong>${escaparHtml(formatarNumero(dados.totalRegistros, 0))}</strong>
          <small>${dados.tipoRelatorio === "Estoque atual" ? (idiomaAtual === "en-US" ? "Grouped positions" : "Posições agrupadas") : (idiomaAtual === "en-US" ? "Tickets / vehicles in filter" : "Tickets / veículos no filtro")}</small>
        </div>
        <div class="modal-relatorio__kpi">
          <span>${idiomaAtual === "en-US" ? "Total moved weight" : "Peso total movimentado"}</span>
          <strong>${escaparHtml(formatarNumero(dados.pesoTotalKg, 0))} kg</strong>
          <small>${idiomaAtual === "en-US" ? "Equivalent to" : "Equivalente a"} ${escaparHtml(formatarNumero(dados.pesoTotalTon, 2))} t</small>
        </div>
        <div class="modal-relatorio__kpi">
          <span>${idiomaAtual === "en-US" ? "Average stay time" : "Tempo médio de permanência"}</span>
          <strong>${escaparHtml(formatarNumero(dados.tempoMedioMin, 0))} min</strong>
          <small>${idiomaAtual === "en-US" ? "Operational average" : "Média operacional do recorte"}</small>
        </div>
        <div class="modal-relatorio__kpi ${dados.totalAlertas > 0 ? "modal-relatorio__kpi--critico" : ""}">
          <span>${idiomaAtual === "en-US" ? "Critical alerts in query" : "Alertas críticos no recorte"}</span>
          <strong>${escaparHtml(formatarNumero(dados.totalAlertas, 0))}</strong>
          <small>${dados.totalAlertas > 0 ? (idiomaAtual === "en-US" ? "Requires CCO attention" : "Requer atenção do CCO") : (idiomaAtual === "en-US" ? "Operation within limits" : "Operação dentro do limite")}</small>
        </div>
      `;
    }
  }

  if (noteEl) {
    if (dados.notaContextual) {
      noteEl.hidden = false;
      noteEl.textContent = dados.notaContextual;
    } else {
      noteEl.hidden = true;
      noteEl.textContent = "";
    }
  }

  if (tableEl) {
    dados.colunas.forEach((col, idx) => {
      tableEl.style.setProperty(`--label-${idx + 1}`, `"${col}"`);
    });
  }

  theadEl.innerHTML = `
    <tr>
      ${dados.colunas.map(col => `<th scope="col">${escaparHtml(col)}</th>`).join("")}
    </tr>
  `;

  if (!dados.linhasCSV.length) {
    const msgVazia =
      idiomaAtual === "en-US"
        ? `No records found for "${escaparHtml(dados.tipoRelatorio)}" in unit ${escaparHtml(dados.rotuloUnidade)}.`
        : `Nenhum registro encontrado para "${escaparHtml(dados.tipoRelatorio)}" na unidade ${escaparHtml(dados.rotuloUnidade)}.`;
    tbodyEl.innerHTML = `
      <tr>
        <td colspan="${dados.colunas.length}" class="tabela__linha-vazia">
          ${msgVazia}
        </td>
      </tr>
    `;
  } else {
    tbodyEl.innerHTML = dados.linhasHTML;
  }

  if (typeof modal.showModal === "function") {
    if (!modal.open) {
      modal.showModal();
    }
  } else {
    modal.setAttribute("open", "");
  }
}

function fecharModalDetalhesRelatorio() {
  const modal = document.getElementById("report-details-modal");
  if (!modal) return;
  if (typeof modal.close === "function" && modal.open) {
    modal.close();
  } else {
    modal.removeAttribute("open");
  }
}

const selectReportType = document.getElementById("report-type");
if (selectReportType) {
  selectReportType.addEventListener("change", () => {
    aplicarFiltroRelatorios();
  });
}

const selectReportUnidade = document.getElementById("report-unidade");
if (selectReportUnidade) {
  selectReportUnidade.addEventListener("change", () => {
    aplicarFiltroRelatorios();
    notify(`Relatórios atualizados para unidade: ${selectReportUnidade.value === "all" ? "Todas" : selectReportUnidade.value}.`);
  });
}

const selectReportPeriod = document.getElementById("report-period");
if (selectReportPeriod) {
  selectReportPeriod.addEventListener("change", () => {
    aplicarFiltroRelatorios();
    notify("Período de consulta dos relatórios atualizado.");
  });
}

document.querySelectorAll(".relatorio__acao").forEach(button => {
  button.addEventListener("click", event => {
    const card = event.target.closest(".relatorio");
    const tipo = card ? card.dataset.type : "Movimentação de carga";
    abrirModalDetalhesRelatorio(tipo);
  });
});

const reportModalEl = document.getElementById("report-details-modal");
const reportModalCloseBtn = document.getElementById("report-modal-close");
const reportModalCloseIconBtn = document.getElementById("report-modal-close-icon");
const reportModalExportCsvBtn = document.getElementById("report-modal-export-csv");

if (reportModalCloseBtn) {
  reportModalCloseBtn.addEventListener("click", fecharModalDetalhesRelatorio);
}

if (reportModalCloseIconBtn) {
  reportModalCloseIconBtn.addEventListener("click", fecharModalDetalhesRelatorio);
}

if (reportModalExportCsvBtn) {
  reportModalExportCsvBtn.addEventListener("click", () => {
    if (!relatorioModalAtual) return;
    exportarRelatorioCSV(
      relatorioModalAtual.tipoRelatorio,
      relatorioModalAtual.linhasCSV,
      relatorioModalAtual.colunas
    );
  });
}

if (
  reportModalEl &&
  typeof HTMLDialogElement !== "undefined" &&
  !("closedBy" in HTMLDialogElement.prototype)
) {
  reportModalEl.addEventListener("click", event => {
    if (event.target !== reportModalEl) return;
    const rect = reportModalEl.getBoundingClientRect();
    const isDialogContent =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (isDialogContent) return;
    fecharModalDetalhesRelatorio();
  });
}

/* =========================================
   CADASTRO DE VEÍCULOS (PERSISTENTE + MESCLADO COM API)
========================================= */

function recalcularContadoresOverviewDelta(veiculo, delta) {
  if (!veiculo) return;
  const kpiFlow = document.getElementById("kpi-flow");
  if (kpiFlow) {
    const valorAtual = Number(String(kpiFlow.textContent).replace(/\D/g, "")) || 0;
    kpiFlow.textContent = Math.max(0, valorAtual + delta);
  }

  document.querySelectorAll(".grade-esteira .esteira__etapa").forEach(card => {
    const groupFilter = card.dataset.groupFilter;
    if (groupFilter) {
      if (pertenceAoGrupoAreaPrimaria(veiculo.stage, groupFilter)) {
        const strong = card.querySelector(".card-area-primaria__valor, strong");
        if (strong) {
          const qtdAtual = Number(String(strong.textContent).replace(/\D/g, "")) || 0;
          strong.textContent = Math.max(0, qtdAtual + delta);
        }
      }
      return;
    }

    const rawStage =
      card.dataset.stageFilter || card.querySelector("span")?.textContent || "";
    if (coincidirEtapa(veiculo.stage, rawStage)) {
      const strong = card.querySelector("strong");
      if (strong) {
        const qtdAtual = Number(String(strong.textContent).replace(/\D/g, "")) || 0;
        strong.textContent = Math.max(0, qtdAtual + delta);
      }
    }
  });

  document.querySelectorAll(".grade-bercos .berco").forEach(card => {
    const rawBerco =
      card.dataset.bercoFilter || card.querySelector(".berco__titulo")?.textContent || "";
    if (coincidirDestino(veiculo.flow, rawBerco)) {
      const detalhes = card.querySelectorAll(".berco__detalhes strong");
      const ultimoStrong = detalhes[detalhes.length - 1];
      if (ultimoStrong) {
        const qtdAtual = Number(String(ultimoStrong.textContent).replace(/\D/g, "")) || 0;
        ultimoStrong.textContent = Math.max(0, qtdAtual + delta);
      }
    }
  });
}

function atualizarContadoresOverviewComNovoVeiculo(novoVeiculo) {
  recalcularContadoresOverviewDelta(novoVeiculo, 1);
}

const atualizarContadoresAoAdicionarRemoverVeiculo = recalcularContadoresOverviewDelta;

function atualizarInterfacesAposAlteracaoVeiculos() {
  if (typeof renderizarCardsAreaPrimaria === "function") {
    renderizarCardsAreaPrimaria(ultimasEtapasAPI);
  }
  renderMovements();
  renderCarriers();
  atualizarPainelTransportadorasOverview();
  if (typeof atualizarGraficoFluxoOverview === "function") atualizarGraficoFluxoOverview();
  atualizarSubtitulosRelatorios();
  renderizarListaVeiculosLocais();
  atualizarBotaoRestaurarRemovidos();
}

function formatarHorarioExclusao(valor) {
  if (!valor) {
    return new Date().toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }
  const str = String(valor).trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(str)) {
    return str;
  }
  const data = new Date(str);
  if (!Number.isNaN(data.getTime())) {
    return data.toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }
  return str;
}

function registrarExclusaoNoHistorico(registro, origem) {
  if (!registro) return;
  const placaNorm = normalizarTexto(registro.plate);
  if (placaNorm && historicoVeiculosExcluidos.some(h => normalizarTexto(h.registro?.plate) === placaNorm)) {
    return;
  }
  const horarioFormatado = new Date().toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  historicoVeiculosExcluidos.push({
    origem,
    removidoEm: horarioFormatado,
    registro: { ...registro }
  });
  salvarHistoricoExcluidosStorage(historicoVeiculosExcluidos);
}

function removerVeiculoLocal(idOuPlaca, registrarHistorico = true) {
  const alvoNorm = normalizarTexto(idOuPlaca);
  if (!alvoNorm) return false;

  const removido = veiculosCadastradosLocalmente.find(
    v =>
      normalizarTexto(v.id) === alvoNorm ||
      normalizarTexto(v.plate) === alvoNorm
  );
  if (!removido) return false;

  veiculosCadastradosLocalmente = veiculosCadastradosLocalmente.filter(
    v =>
      normalizarTexto(v.id) !== alvoNorm &&
      normalizarTexto(v.plate) !== alvoNorm
  );
  salvarVeiculosLocaisStorage(veiculosCadastradosLocalmente);

  if (registrarHistorico) {
    registrarExclusaoNoHistorico(removido, "local");
  }

  const placaNorm = normalizarTexto(removido.plate);
  if (Array.isArray(cacheTodosVeiculosAPI)) {
    cacheTodosVeiculosAPI = cacheTodosVeiculosAPI.filter(
      v => normalizarTexto(v.plate) !== placaNorm
    );
  }
  if (Array.isArray(veiculosAtivosAPI)) {
    veiculosAtivosAPI = veiculosAtivosAPI.filter(
      v => normalizarTexto(v.plate) !== placaNorm
    );
  }

  recalcularContadoresOverviewDelta(removido, -1);
  atualizarInterfacesAposAlteracaoVeiculos();
  return true;
}

function removerRegistroVeiculo(chaveOuPlaca, origemLocal = false) {
  const alvoNorm = normalizarTexto(chaveOuPlaca);
  if (!alvoNorm) return;

  if (origemLocal && removerVeiculoLocal(alvoNorm, true)) {
    return;
  }

  const fonteAtual = obterFonteVeiculosCompleta();
  const alvo = fonteAtual.find(
    v =>
      obterChaveRegistroVeiculo(v) === alvoNorm ||
      normalizarTexto(v.plate) === alvoNorm
  );

  if (alvo && alvo.origem === "local") {
    removerVeiculoLocal(alvo.plate, true);
    return;
  }

  const placaNorm = normalizarTexto(alvo?.plate || chaveOuPlaca);
  if (placaNorm) {
    veiculosRemovidosSessao.add(placaNorm);
  }
  if (alvo) {
    registrarExclusaoNoHistorico(alvo, "api");
  }
  salvarVeiculosRemovidosStorage(veiculosRemovidosSessao);

  const filtrarLista = lista =>
    Array.isArray(lista)
      ? lista.filter(
          v =>
            obterChaveRegistroVeiculo(v) !== alvoNorm &&
            normalizarTexto(v.plate) !== alvoNorm
        )
      : lista;

  cacheTodosVeiculosAPI = filtrarLista(cacheTodosVeiculosAPI);
  veiculosAtivosAPI = filtrarLista(veiculosAtivosAPI);

  if (alvo) {
    recalcularContadoresOverviewDelta(alvo, -1);
  }

  atualizarInterfacesAposAlteracaoVeiculos();
}

function renderizarListaRestauracaoModal() {
  const listEl = document.getElementById("restore-vehicles-list");
  const restoreAllBtn = document.getElementById("restore-all-vehicles-submit");
  if (restoreAllBtn) {
    restoreAllBtn.textContent = t("restore_modal.restore_all", { n: historicoVeiculosExcluidos.length });
    restoreAllBtn.disabled = historicoVeiculosExcluidos.length === 0;
  }
  if (!listEl) return;

  if (!historicoVeiculosExcluidos.length) {
    listEl.innerHTML = `<div class="modal-restauracao__vazio">${escaparHtml(t("restore_modal.empty"))}</div>`;
    return;
  }

  listEl.innerHTML = historicoVeiculosExcluidos
    .map((item, idx) => {
      const reg = item?.registro || {};
      const placa = escaparHtml(reg.plate ?? reg.Placa ?? "—");
      const ticket = escaparHtml(reg.ticket ?? reg.Ticket ?? "MOV-2026-00001");
      const unidade = escaparHtml(
        String(reg.unidade ?? reg.NomeEmpresa ?? "COPISI").toUpperCase()
      );
      const isLocal = item?.origem === "local";
      const badgeClass = isLocal
        ? "modal-restauracao__badge modal-restauracao__badge--local"
        : "modal-restauracao__badge";
      const badgeLabel = traduzirOrigemRegistro(isLocal ? "local" : "api");

      const transportadora = escaparHtml(
        reg.carrier ?? reg.NomeTransportadora ?? "—"
      );
      const motorista = escaparHtml(
        reg.driver ?? reg.NomeMotorista ?? "—"
      );
      const cliente = escaparHtml(
        reg.cliente ?? reg.NomeCliente ?? "—"
      );
      const operacao = reg.operation || "Recebimento";
      const tipoMov =
        reg.tipoMovimentacao ??
        reg.TipoMovimentacao ??
        (coincidirOperacao(operacao, "Expedição") ? "Saída" : "Entrada");
      const operacaoLabel = escaparHtml(`${traduzirOperacao(operacao)} (${traduzirOperacao(tipoMov)})`);

      const destinoBox = escaparHtml(
        traduzirDestino(reg.localFisico ?? reg.Local ?? reg.flow ?? "—")
      );
      const etapa = escaparHtml(traduzirEtapa(reg.stage || "—"));
      const pesoNum = obterPesoNumericoVeiculoRelatorio(reg);
      const pesoLabel = escaparHtml(
        pesoNum > 0 ? `${formatarNumero(pesoNum, 0)} kg` : "Peso pendente"
      );
      const horarioExclusao = escaparHtml(
        formatarHorarioExclusao(item?.removidoEm)
      );

      return `
        <div class="modal-restauracao__item">
          <div class="modal-restauracao__info">
            <div class="modal-restauracao__topo">
              <span class="modal-restauracao__placa restore-deleted-plate">${placa}</span>
              <span class="modal-restauracao__badge modal-restauracao__badge--ticket">${ticket}</span>
              <span class="modal-restauracao__badge modal-restauracao__badge--unidade">${unidade}</span>
              <span class="${badgeClass}">${badgeLabel}</span>
            </div>
            <div class="modal-restauracao__meta">${transportadora} · ${motorista} · ${cliente} · ${operacaoLabel}</div>
            <div class="modal-restauracao__detalhes">
              <span>${destinoBox} · ${etapa} · ${pesoLabel}</span>
              <span class="modal-restauracao__horario">Excluído às ${horarioExclusao}</span>
            </div>
          </div>
          <button type="button" class="botao botao--claro" data-restore-index="${idx}">
            Restaurar
          </button>
        </div>
      `;
    })
    .join("");
}

function abrirModalRestauracao() {
  const modal = document.getElementById("restore-vehicles-modal") || document.getElementById("restore-deleted-modal");
  if (!modal) return;
  renderizarListaRestauracaoModal();
  modal.hidden = false;
}

function fecharModalRestauracao() {
  const modal = document.getElementById("restore-vehicles-modal") || document.getElementById("restore-deleted-modal");
  if (modal) {
    modal.hidden = true;
  }
}

async function restaurarRegistroDoHistorico(item) {
  const reg = item?.registro;
  if (!reg) return;

  if (item.origem === "local") {
    const existe = veiculosCadastradosLocalmente.some(
      v => normalizarTexto(v.plate) === normalizarTexto(reg.plate)
    );
    if (!existe) {
      veiculosCadastradosLocalmente = [reg, ...veiculosCadastradosLocalmente];
      salvarVeiculosLocaisStorage(veiculosCadastradosLocalmente);
    }
    if (Array.isArray(cacheTodosVeiculosAPI)) {
      cacheTodosVeiculosAPI = mesclarVeiculosComLocais(cacheTodosVeiculosAPI);
    }
    if (Array.isArray(veiculosAtivosAPI)) {
      veiculosAtivosAPI = mesclarVeiculosComLocais(veiculosAtivosAPI);
    }
    recalcularContadoresOverviewDelta(reg, 1);
  } else {
    const chave = obterChaveRegistroVeiculo(reg);
    const placaNorm = normalizarTexto(reg.plate);
    veiculosRemovidosSessao.delete(chave);
    veiculosRemovidosSessao.delete(placaNorm);
    salvarVeiculosRemovidosStorage(veiculosRemovidosSessao);

    if (Array.isArray(cacheTodosVeiculosAPI)) {
      cacheTodosVeiculosAPI = mesclarVeiculosComLocais([reg, ...cacheTodosVeiculosAPI.filter(
        v => normalizarTexto(v.plate) !== placaNorm
      )]);
    }
    if (Array.isArray(veiculosAtivosAPI)) {
      veiculosAtivosAPI = mesclarVeiculosComLocais([reg, ...veiculosAtivosAPI.filter(
        v => normalizarTexto(v.plate) !== placaNorm
      )]);
    }
    recalcularContadoresOverviewDelta(reg, 1);
    await sincronizarTodosEndpoints();
  }
}

async function restaurarVeiculoPorIndice(indice) {
  if (!Number.isInteger(indice) || indice < 0 || indice >= historicoVeiculosExcluidos.length) {
    return;
  }
  const [item] = historicoVeiculosExcluidos.splice(indice, 1);
  salvarHistoricoExcluidosStorage(historicoVeiculosExcluidos);

  if (!item?.registro) return;

  await restaurarRegistroDoHistorico(item);
  atualizarInterfacesAposAlteracaoVeiculos();

  if (historicoVeiculosExcluidos.length === 0) {
    fecharModalRestauracao();
  } else {
    renderizarListaRestauracaoModal();
  }

  notify(`Veículo ${item.registro.plate} restaurado.`);
}

async function restaurarVeiculosRemovidos() {
  const locaisParaRestaurar = historicoVeiculosExcluidos
    .filter(item => item.origem === "local" && item.registro)
    .map(item => item.registro);

  if (locaisParaRestaurar.length > 0) {
    const placasAtuais = new Set(
      veiculosCadastradosLocalmente.map(v => normalizarTexto(v.plate))
    );
    const novosLocais = locaisParaRestaurar.filter(
      v => !placasAtuais.has(normalizarTexto(v.plate))
    );
    veiculosCadastradosLocalmente = [...novosLocais, ...veiculosCadastradosLocalmente];
    salvarVeiculosLocaisStorage(veiculosCadastradosLocalmente);
    novosLocais.forEach(v => recalcularContadoresOverviewDelta(v, 1));
  }

  veiculosRemovidosSessao.clear();
  historicoVeiculosExcluidos = [];
  try {
    sessionStorage.removeItem(STORAGE_KEY_VEICULOS_REMOVIDOS);
    sessionStorage.removeItem(STORAGE_KEY_HISTORICO_EXCLUIDOS);
  } catch (e) {
    console.warn("Não foi possível limpar exclusões da sessão:", e);
  }

  atualizarBotaoRestaurarRemovidos();
  fecharModalRestauracao();
  await sincronizarTodosEndpoints();
  atualizarInterfacesAposAlteracaoVeiculos();
  notify("Todos os veículos excluídos foram restaurados.");
}

function limparVeiculosLocais() {
  if (!veiculosCadastradosLocalmente.length) return;
  const removidos = [...veiculosCadastradosLocalmente];
  removidos.forEach(v => registrarExclusaoNoHistorico(v, "local"));
  veiculosCadastradosLocalmente = [];
  salvarVeiculosLocaisStorage([]);

  const placasRemovidas = new Set(removidos.map(v => normalizarTexto(v.plate)));
  if (Array.isArray(cacheTodosVeiculosAPI)) {
    cacheTodosVeiculosAPI = cacheTodosVeiculosAPI.filter(
      v => !(v.origem === "local" || placasRemovidas.has(normalizarTexto(v.plate)))
    );
  }
  if (Array.isArray(veiculosAtivosAPI)) {
    veiculosAtivosAPI = veiculosAtivosAPI.filter(
      v => !(v.origem === "local" || placasRemovidas.has(normalizarTexto(v.plate)))
    );
  }

  removidos.forEach(v => recalcularContadoresOverviewDelta(v, -1));
  atualizarInterfacesAposAlteracaoVeiculos();
  notify("Todos os cadastros locais foram removidos.");
}

function renderizarListaVeiculosLocais() {
  const listEl = document.getElementById("local-vehicles-list");
  const btnLimpar = document.getElementById("btn-limpar-veiculos-locais");
  if (!listEl) return;

  if (btnLimpar) {
    btnLimpar.hidden = veiculosCadastradosLocalmente.length === 0;
  }

  if (!veiculosCadastradosLocalmente.length) {
    listEl.innerHTML = `<p class="cadastro__lista-vazia">${escaparHtml(t("vehicles.empty_local"))}</p>`;
    return;
  }

  listEl.innerHTML = veiculosCadastradosLocalmente
    .map(
      v => `
        <div class="cadastro__item-local">
          <div class="cadastro__item-info">
            <strong><span class="cadastro__placa-local">${escaparHtml(v.plate)}</span> · ${escaparHtml(v.carrier)} (${escaparHtml(v.unidade || "COPISI")})</strong>
            <small>Ticket: ${escaparHtml(v.ticket || "—")} · ${escaparHtml(traduzirOperacao(v.operation))} · ${escaparHtml(traduzirDestino(v.flow))} · ${escaparHtml(t("table.stage"))}: ${escaparHtml(traduzirEtapa(v.stage))}</small>
          </div>
          <button
            type="button"
            class="btn-remover-registro"
            data-remove-local-plate="${escaparHtml(v.plate)}"
          >
            ${escaparHtml(t("movements.remove_btn"))}
          </button>
        </div>
      `
    )
    .join("");
}

function exibirFeedbackCadastro(mensagemTitulo, mensagemDetalhe, erro = false, placaCadastrada = "") {
  const feedbackEl = document.getElementById("vehicle-feedback");
  if (!feedbackEl) return;

  feedbackEl.hidden = false;
  feedbackEl.classList.toggle("cadastro__feedback--erro", erro);

  if (erro) {
    feedbackEl.innerHTML = `
      <div class="cadastro__feedback-texto">
        <strong>⚠ ${escaparHtml(mensagemTitulo)}</strong>
        <span>${escaparHtml(mensagemDetalhe)}</span>
      </div>
    `;
    return;
  }

  feedbackEl.innerHTML = `
    <div class="cadastro__feedback-texto">
      <strong>✓ ${escaparHtml(mensagemTitulo)}</strong>
      <span>${escaparHtml(mensagemDetalhe)} (${veiculosCadastradosLocalmente.length} veículo(s) cadastrado(s) localmente nesta sessão)</span>
    </div>
    <div class="cadastro__feedback-botoes">
      <button type="button" class="botao" data-action="view-registered-vehicle" data-plate="${escaparHtml(placaCadastrada)}">
        Ver veículo em Movimentações →
      </button>
    </div>
  `;
}

document.addEventListener("click", event => {
  const btnViewVehicle = event.target.closest("[data-action='view-registered-vehicle']");
  if (!btnViewVehicle) return;

  const placa = btnViewVehicle.dataset.plate || "";
  const selectUnidade = document.getElementById("movement-unidade");
  const selectDestino = document.getElementById("movement-destino");
  const selectEtapa = document.getElementById("movement-etapa");
  const inputPlaca = document.getElementById("plate-filter");
  const selectCarrier = document.getElementById("movement-carrier");
  const selectOp = document.getElementById("movement-operation");

  if (selectUnidade) selectUnidade.value = "all";
  if (selectDestino) selectDestino.value = "all";
  if (selectEtapa) selectEtapa.value = "all";
  if (selectCarrier) selectCarrier.value = "all";
  if (selectOp) selectOp.value = "all";
  if (inputPlaca) inputPlaca.value = placa;

  contextoInspecaoCard = null;
  showPage("movements");
  renderMovements();
  notify(`Exibindo veículo recém-cadastrado: ${placa}`);
});

function gerarProximoTicketIPort() {
  const todos = obterFonteVeiculosCompleta();
  let maiorSeq = 100;
  todos.forEach(v => {
    const tk = String(v.ticket ?? v.Ticket ?? "");
    const match = tk.match(/MOV-2026-(\d+)/i);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > maiorSeq) {
        maiorSeq = n;
      }
    }
  });
  return `MOV-2026-${String(maiorSeq + 1).padStart(5, "0")}`;
}

const formVehicles = document.getElementById("form-vehicles");
if (formVehicles) {
  formVehicles.addEventListener("submit", event => {
    event.preventDefault();

    const placaInput = document.getElementById("vehicle-plate");
    const carrierInput = document.getElementById("vehicle-carrier");
    const typeSelect = document.getElementById("vehicle-type");
    const operationSelect = document.getElementById("vehicle-operation");
    const destinoSelect = document.getElementById("vehicle-destino");
    const stageSelect = document.getElementById("vehicle-stage");
    const weightInput = document.getElementById("vehicle-weight");
    const unidadeSelect = document.getElementById("vehicle-unidade");
    const driverInput = document.getElementById("vehicle-driver");
    const clientInput = document.getElementById("vehicle-client");
    const obsInput = document.getElementById("vehicle-obs");

    const placa = (placaInput?.value || "").trim().toUpperCase();
    const transportadora = (carrierInput?.value || "").trim();
    const tipoVeiculo = typeSelect?.value || "Carreta";
    const operacao = operationSelect?.value || "Recebimento";
    const destino = normalizarRotuloDestino(destinoSelect?.value || "Berço 99") || "Berço 99";
    const etapa = normalizarRotuloEtapa(stageSelect?.value || "PAN") || "PAN";
    const pesoLiquidoNum = weightInput?.value ? Number(weightInput.value) : null;
    const unidade = (unidadeSelect?.value || "COPISI").trim().toUpperCase();
    const motoristaInformado = (driverInput?.value || "").trim();
    const clienteInformado = (clientInput?.value || "").trim();
    const observacao = (obsInput?.value || "").trim();

    if (!placa) {
      exibirFeedbackCadastro(
        "Placa obrigatória",
        "Informe a placa do veículo (ex.: ABC1D23) antes de cadastrar.",
        true
      );
      notify("Informe a placa do veículo para concluir o cadastro.");
      placaInput?.focus();
      return;
    }

    if (!transportadora) {
      exibirFeedbackCadastro(
        "Transportadora obrigatória",
        "Informe o nome da transportadora responsável pelo veículo.",
        true
      );
      notify("Informe a transportadora do veículo.");
      carrierInput?.focus();
      return;
    }

    const horarioAtual = new Date().toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit"
    });
    const dataAtual = new Date().toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo"
    });
    const dataHoraMovimentacao = `${dataAtual} ${horarioAtual}`;

    const mapaEixos = {
      Caminhão: 4,
      Carreta: 6,
      Bitrem: 7,
      Rodotrem: 9,
      Outro: 6
    };
    const eixos = mapaEixos[tipoVeiculo] || 6;

    const taraPadraoKg = eixos * 2850;
    const temPeso = pesoLiquidoNum !== null && !Number.isNaN(pesoLiquidoNum) && pesoLiquidoNum > 0;
    const pesoBrutoKg = temPeso ? taraPadraoKg + pesoLiquidoNum : null;
    const limiteSobrepesoAtivo = Number(configOperacionalCCO?.limiteSobrepesoKg) || 48500;
    const possuiSobrepeso = pesoBrutoKg !== null && pesoBrutoKg > limiteSobrepesoAtivo;

    let navio = "PRESTIGE DIVA";
    let tipoDocLote = coincidirOperacao(operacao, "Expedição") ? "BL" : "DI";
    let codigoBL = `BL-ITQ-2026-${String(veiculosCadastradosLocalmente.length + 101).padStart(3, "0")}`;
    if (observacao) {
      if (observacao.includes("·")) {
        const [parteNavio, parteBL] = observacao.split("·").map(s => s.trim());
        if (parteNavio) navio = parteNavio;
        if (parteBL) codigoBL = parteBL;
      } else if (/^(?:BL|DI)/i.test(observacao)) {
        codigoBL = observacao;
      } else {
        navio = observacao;
      }
      if (/^DI\b/i.test(codigoBL)) {
        tipoDocLote = "DI";
        codigoBL = codigoBL.replace(/^DI\s*/i, "").trim();
      } else if (/^BL\b/i.test(codigoBL)) {
        tipoDocLote = "BL";
      }
    }

    const situacaoInicial =
      possuiSobrepeso
        ? "Parado"
        : normalizarTexto(etapa).includes("gate out")
        ? "Finalizado"
        : "Em operação";

    const ticketGerado = gerarProximoTicketIPort();
    const tipoMov = coincidirOperacao(operacao, "Expedição") ? "Saída" : "Entrada";
    const motoristaFinal = motoristaInformado || `Motorista (${tipoVeiculo})`;
    const clienteFinal = clienteInformado || "Cliente Operação Portuária";
    const pesoMovimentadoKg = temPeso ? pesoLiquidoNum : taraPadraoKg;

    const novoVeiculo = {
      origem: "local",
      plate: placa,
      Placa: placa,
      ticket: ticketGerado,
      Ticket: ticketGerado,
      statusTicket: "1 - Ativo",
      Status: "1 - Ativo",
      unidade,
      NomeEmpresa: unidade,
      tipoMovimentacao: tipoMov,
      TipoMovimentacao: tipoMov,
      ship: navio,
      referencia: navio,
      Referencia: navio,
      flow: destino,
      localFisico: `${destino} · ${etapa}`,
      Local: `${destino} · ${etapa}`,
      window: "415",
      bl: codigoBL,
      tipoDocumentoLote: tipoDocLote,
      TipoDocumentoLote: tipoDocLote,
      numeroDocumentoLote: codigoBL,
      NumeroDocumentoLote: codigoBL,
      driver: motoristaFinal,
      NomeMotorista: motoristaFinal,
      carrier: transportadora,
      NomeTransportadora: transportadora,
      cliente: clienteFinal,
      NomeCliente: clienteFinal,
      operation: operacao,
      entry: horarioAtual,
      entryPAN: dataHoraMovimentacao,
      dataMovimentacao: dataHoraMovimentacao,
      DataMovimentacao: dataHoraMovimentacao,
      axles: eixos,
      tareWeight: formatarNumero(taraPadraoKg),
      tareDate: dataHoraMovimentacao,
      collectorDate: temPeso ? dataHoraMovimentacao : "—",
      grossWeight: pesoBrutoKg !== null ? formatarNumero(pesoBrutoKg) : null,
      netWeight: temPeso ? formatarNumero(pesoLiquidoNum) : null,
      pesoNumerico: pesoMovimentadoKg,
      pesoMovimentadoKg,
      PesoMovimentado: pesoMovimentadoKg,
      grossDate: pesoBrutoKg !== null ? dataHoraMovimentacao : "—",
      overweight: possuiSobrepeso ? "Sim (Sobrepeso)" : "Não",
      exit: situacaoInicial === "Finalizado" ? horarioAtual : "—",
      duration: "1 min",
      durationMin: 1,
      stage: etapa,
      status: situacaoInicial,
      possui_alerta: possuiSobrepeso
    };

    // Persiste na lista local (sem duplicar placa) e salva em localStorage/sessionStorage
    veiculosCadastradosLocalmente = [
      novoVeiculo,
      ...veiculosCadastradosLocalmente.filter(
        v => normalizarTexto(v.plate) !== normalizarTexto(placa)
      )
    ];
    salvarVeiculosLocaisStorage(veiculosCadastradosLocalmente);

    if (Array.isArray(cacheTodosVeiculosAPI)) {
      cacheTodosVeiculosAPI = mesclarVeiculosComLocais(cacheTodosVeiculosAPI);
    }
    if (Array.isArray(veiculosAtivosAPI)) {
      veiculosAtivosAPI = mesclarVeiculosComLocais(veiculosAtivosAPI);
    }

    const baseAtual = obterFonteVeiculosCompleta();
    atualizarOpcoesSelect(
      "movement-carrier",
      baseAtual.map(v => v.carrier),
      "Todas",
      ["Transporte Alfa", "Translog", "Veloz Cargas", "Rota Sul", "Logística Brasil"]
    );
    atualizarOpcoesSelect(
      "movement-destino",
      baseAtual.map(v => v.flow),
      "Todos",
      DESTINOS_PADRAO
    );
    atualizarOpcoesSelect(
      "movement-etapa",
      baseAtual.map(v => v.stage),
      "Todas",
      ETAPAS_PADRAO
    );

    atualizarContadoresOverviewComNovoVeiculo(novoVeiculo);
    renderMovements();
    renderCarriers();
    atualizarPainelTransportadorasOverview();
    atualizarSubtitulosRelatorios();
    renderizarListaVeiculosLocais();

    formVehicles.reset();

    exibirFeedbackCadastro(
      `Veículo ${placa} cadastrado com sucesso! (${ticketGerado})`,
      `Unidade: ${unidade} · Transportadora: ${transportadora} · Cliente: ${clienteFinal} · Destino: ${destino} · Etapa: ${etapa}`,
      false,
      placa
    );

    notify(`Veículo ${placa} (${ticketGerado}) cadastrado na unidade ${unidade}.`);
  });
}

/* =========================================
   MODO CLARO E ESCURO E CONFIGURAÇÕES OPERACIONAIS (CCO)
========================================= */

const themeSelect = document.getElementById("theme-select");
const temaSalvo = localStorage.getItem("tema") || "light";

document.body.classList.toggle("tema--escuro", temaSalvo === "dark");

if (themeSelect) {
  themeSelect.value = temaSalvo;

  themeSelect.addEventListener("change", event => {
    const darkMode = event.target.value === "dark";
    document.body.classList.toggle("tema--escuro", darkMode);
    localStorage.setItem("tema", darkMode ? "dark" : "light");
    notify(`Tema ${darkMode ? "escuro" : "claro"} aplicado.`);
  });
}

/* =========================================
   DATA E HORÁRIO INICIAL
========================================= */

const date = new Date();
const elCurrentDate = document.getElementById("current-date");
if (elCurrentDate) {
  elCurrentDate.textContent = date.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

const elCurrentTime = document.getElementById("current-time");
if (elCurrentTime) {
  elCurrentTime.textContent =
    date.toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit"
    }) + " · sincronizando...";
}

/* =========================================
   INICIALIZAÇÃO DAS TABELAS E GRÁFICO
========================================= */

renderMovements(false);
renderCarriers();
atualizarPainelTransportadorasOverview();
atualizarSubtitulosRelatorios();
renderizarListaVeiculosLocais();

let registroPendenteExclusao = null;

function abrirModalConfirmacaoExclusao(chave, isLocal, placa, transportadora) {
  let placaFinal = placa || chave || "—";
  let carrierFinal = transportadora || "";

  if (!carrierFinal) {
    const alvoNorm = normalizarTexto(chave || placa);
    const fonte = typeof obterFonteVeiculosCompleta === "function" ? obterFonteVeiculosCompleta() : [];
    const alvo = fonte.find(
      v =>
        (typeof obterChaveRegistroVeiculo === "function" && obterChaveRegistroVeiculo(v) === alvoNorm) ||
        normalizarTexto(v.plate) === alvoNorm
    );
    if (alvo) {
      if (alvo.plate) placaFinal = alvo.plate;
      if (alvo.carrier) carrierFinal = alvo.carrier;
    }
  }

  registroPendenteExclusao = { chave, isLocal, placa: placaFinal, transportadora: carrierFinal };
  const modal = document.getElementById("confirm-delete-movement-modal");
  const descEl = document.getElementById("confirm-delete-desc");
  if (!modal) {
    removerRegistroVeiculo(chave, isLocal);
    return;
  }

  const carrierHtml = carrierFinal ? ` (<strong>${escaparHtml(carrierFinal)}</strong>)` : "";
  if (descEl) {
    if (idiomaAtual === "en-US") {
      descEl.innerHTML = `Do you really want to remove vehicle <strong>${escaparHtml(placaFinal)}</strong>${carrierHtml} from operational listings? You can restore it later in "Restore deleted".`;
    } else {
      descEl.innerHTML = `Deseja realmente remover o veículo de placa <strong>${escaparHtml(placaFinal)}</strong>${carrierHtml} da listagem operacional? Você poderá restaurá-lo depois em "Restaurar excluídos".`;
    }
  }

  const badgeEl = modal.querySelector(".modal-confirmar-exclusao__badge");
  const titleEl = document.getElementById("confirm-delete-title");
  const submitBtn = document.getElementById("confirm-delete-submit");
  const cancelBtn = document.getElementById("confirm-delete-cancel");

  if (badgeEl) {
    badgeEl.textContent = idiomaAtual === "en-US" ? "WARNING · RECORD DELETION" : "ATENÇÃO · EXCLUSÃO DE REGISTRO";
  }
  if (titleEl) {
    titleEl.textContent = idiomaAtual === "en-US" ? "Confirm vehicle removal?" : "Confirmar remoção do veículo?";
  }
  if (submitBtn) {
    submitBtn.textContent = idiomaAtual === "en-US" ? "Yes, remove" : "Sim, remover";
  }
  if (cancelBtn) {
    cancelBtn.textContent = idiomaAtual === "en-US" ? "Cancel" : "Cancelar";
  }

  if (typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute("open", "");
  }
}

function fecharModalConfirmacaoExclusao() {
  const modal = document.getElementById("confirm-delete-movement-modal");
  if (modal) {
    if (typeof modal.close === "function" && modal.open) {
      modal.close();
    } else {
      modal.removeAttribute("open");
    }
  }
  registroPendenteExclusao = null;
}

const confirmDeleteModalEl = document.getElementById("confirm-delete-movement-modal");
const confirmDeleteSubmitBtn = document.getElementById("confirm-delete-submit");
const confirmDeleteCancelBtn = document.getElementById("confirm-delete-cancel");

if (confirmDeleteSubmitBtn) {
  confirmDeleteSubmitBtn.addEventListener("click", () => {
    if (registroPendenteExclusao) {
      const { chave, isLocal } = registroPendenteExclusao;
      fecharModalConfirmacaoExclusao();
      removerRegistroVeiculo(chave, isLocal);
    }
  });
}

if (confirmDeleteCancelBtn) {
  confirmDeleteCancelBtn.addEventListener("click", fecharModalConfirmacaoExclusao);
}

if (confirmDeleteModalEl) {
  confirmDeleteModalEl.addEventListener("click", event => {
    if (event.target === confirmDeleteModalEl) {
      fecharModalConfirmacaoExclusao();
    }
  });
  confirmDeleteModalEl.addEventListener("cancel", () => {
    registroPendenteExclusao = null;
  });
}

function renderizarDetalhesModalResolucaoAlerta(alertaInfo) {
  const detailsEl = document.getElementById("confirm-resolve-alert-details");
  const editedNoticeEl = document.getElementById("confirm-resolve-alert-edited-notice");
  const isEn = idiomaAtual === "en-US";

  if (editedNoticeEl) {
    const alteracoes = alertaInfo?.edicao?.alteracoes;
    if (alertaInfo?.edicao && Array.isArray(alteracoes) && alteracoes.length > 0) {
      editedNoticeEl.hidden = false;
      editedNoticeEl.innerHTML = `<strong>${
        isEn ? "Alert edited:" : "Alerta já editado:"
      }</strong> ${escaparHtml(alteracoes.join(" · "))}`;
    } else {
      editedNoticeEl.hidden = true;
      editedNoticeEl.innerHTML = "";
    }
  }

  if (detailsEl) {
    detailsEl.innerHTML = `
      <div class="modal-resolver-alerta__campo modal-resolver-alerta__campo--largo">
        <span>${isEn ? "Alert type" : "Tipo do alerta"}</span>
        <strong>${escaparHtml(alertaInfo.tipo || "—")}</strong>
      </div>
      <div class="modal-resolver-alerta__campo">
        <span>${isEn ? "Plate" : "Placa"}</span>
        <strong>${escaparHtml(alertaInfo.placa || "—")}</strong>
      </div>
      <div class="modal-resolver-alerta__campo">
        <span>${isEn ? "Stage" : "Etapa"}</span>
        <strong>${escaparHtml(alertaInfo.etapa || "—")}</strong>
      </div>
      <div class="modal-resolver-alerta__campo">
        <span>${isEn ? "Current value" : "Valor atual"}</span>
        <strong>${escaparHtml(alertaInfo.valorAtual || "—")}</strong>
      </div>
      <div class="modal-resolver-alerta__campo">
        <span>${isEn ? "Limit" : "Limite"}</span>
        <strong>${escaparHtml(alertaInfo.limite || "—")}</strong>
      </div>
    `;
  }
}

function alternarModoEdicaoAlerta(emEdicao) {
  const detailsEl = document.getElementById("confirm-resolve-alert-details");
  const editedNoticeEl = document.getElementById("confirm-resolve-alert-edited-notice");
  const formEl = document.getElementById("confirm-resolve-alert-form");
  const actionsViewEl = document.getElementById("confirm-resolve-alert-actions-view");
  const actionsEditEl = document.getElementById("confirm-resolve-alert-actions-edit");

  if (detailsEl) detailsEl.hidden = Boolean(emEdicao);
  if (formEl) formEl.hidden = !emEdicao;
  if (actionsViewEl) actionsViewEl.hidden = Boolean(emEdicao);
  if (actionsEditEl) actionsEditEl.hidden = !emEdicao;

  if (editedNoticeEl) {
    if (emEdicao) {
      editedNoticeEl.hidden = true;
    } else if (
      alertaPendenteResolucao?.edicao?.alteracoes &&
      alertaPendenteResolucao.edicao.alteracoes.length > 0
    ) {
      editedNoticeEl.hidden = false;
    }
  }

  if (emEdicao && alertaPendenteResolucao) {
    const isEn = idiomaAtual === "en-US";
    const stageLabel = document.getElementById("edit-alert-stage-label");
    const valueLabel = document.getElementById("edit-alert-value-label");
    const noteLabel = document.getElementById("edit-alert-note-label");
    const stageInput = document.getElementById("edit-alert-stage");
    const valueInput = document.getElementById("edit-alert-value");
    const noteInput = document.getElementById("edit-alert-note");
    const backBtn = document.getElementById("confirm-resolve-alert-back");
    const saveBtn = document.getElementById("confirm-resolve-alert-save");

    if (stageLabel) stageLabel.textContent = isEn ? "Stage" : "Etapa";
    if (valueLabel) valueLabel.textContent = isEn ? "Current value" : "Valor atual";
    if (noteLabel) noteLabel.textContent = isEn ? "Note (optional)" : "Observação (opcional)";
    if (backBtn) backBtn.textContent = isEn ? "Back" : "Voltar";
    if (saveBtn) saveBtn.textContent = isEn ? "Save edit" : "Salvar edição";

    if (stageInput) stageInput.value = alertaPendenteResolucao.etapa || "";
    if (valueInput) valueInput.value = alertaPendenteResolucao.valorAtual || "";
    if (noteInput) {
      noteInput.value = alertaPendenteResolucao.edicao?.observacao || "";
      noteInput.placeholder = isEn ? "E.g.: Reweighing completed" : "Ex.: Repesagem concluída";
    }
  }
}

function salvarEdicaoAlertaPendente() {
  if (!alertaPendenteResolucao) return;
  const isEn = idiomaAtual === "en-US";
  const stageInput = document.getElementById("edit-alert-stage");
  const valueInput = document.getElementById("edit-alert-value");
  const noteInput = document.getElementById("edit-alert-note");

  const origEtapa = alertaPendenteResolucao.original?.etapa ?? alertaPendenteResolucao.etapa ?? "—";
  const origValor = alertaPendenteResolucao.original?.valorAtual ?? alertaPendenteResolucao.valorAtual ?? "—";
  const origLimite = alertaPendenteResolucao.original?.limite ?? alertaPendenteResolucao.limite ?? "—";

  const novaEtapa = (stageInput?.value || "").trim() || origEtapa;
  const valorDigitado = (valueInput?.value || "").trim();
  const observacao = (noteInput?.value || "").trim();

  let novoValor = valorDigitado || origValor;
  let novoLimite = alertaPendenteResolucao.limite || origLimite;

  const ehAlertaPeso =
    alertaPendenteResolucao.chave?.startsWith("SOBREPESO::") ||
    /\bkg\b/i.test(origValor) ||
    /\bkg\b/i.test(valorDigitado);
  const ehAlertaTempo =
    alertaPendenteResolucao.chave?.startsWith("RETENCAO_PRC::") ||
    /\bmin\b/i.test(origValor) ||
    /\bmin\b/i.test(valorDigitado);

  if (ehAlertaPeso && valorDigitado) {
    const pesoNum = converterPesoParaNumero(valorDigitado);
    if (pesoNum !== null) {
      novoValor = `${formatarNumero(pesoNum, 0)} kg`;
      const limiteConfigSobrepeso = Number(configOperacionalCCO?.limiteSobrepesoKg) || 48500;
      const limiteBaseNum =
        converterPesoParaNumero(String(origLimite).split("·")[0]) || limiteConfigSobrepeso;
      const limiteBaseTexto = `${formatarNumero(limiteBaseNum, 0)} kg`;
      novoLimite =
        pesoNum > limiteBaseNum
          ? `${limiteBaseTexto} · +${formatarNumero(pesoNum - limiteBaseNum, 0)} kg`
          : limiteBaseTexto;
    }
  } else if (ehAlertaTempo && valorDigitado) {
    const matchMin = valorDigitado.replace(/\./g, "").match(/(\d+(?:[.,]\d+)?)/);
    if (matchMin) {
      const mins = Number(matchMin[1].replace(",", "."));
      if (Number.isFinite(mins)) {
        novoValor = `${formatarNumero(mins, 0)} min`;
      }
    }
  }

  const alteracoes = [];
  if (novaEtapa !== origEtapa) {
    alteracoes.push(`${isEn ? "Stage" : "Etapa"}: ${origEtapa} → ${novaEtapa}`);
  }
  if (novoValor !== origValor) {
    alteracoes.push(`${isEn ? "Current value" : "Valor atual"}: ${origValor} → ${novoValor}`);
  }
  if (observacao) {
    alteracoes.push(`Obs: ${observacao}`);
  }

  if (alteracoes.length === 0) {
    alternarModoEdicaoAlerta(false);
    return;
  }

  const edicao = {
    tipo: alertaPendenteResolucao.tipo || "",
    etapa: novaEtapa,
    valorAtual: novoValor,
    limite: novoLimite,
    observacao,
    alteracoes,
    original: {
      etapa: origEtapa,
      valorAtual: origValor,
      limite: origLimite
    },
    atualizadoEm: new Date().toISOString()
  };

  alertasEditadosLocal[alertaPendenteResolucao.chave] = edicao;
  salvarAlertasEditadosLocal();

  alertaPendenteResolucao = {
    ...alertaPendenteResolucao,
    etapa: novaEtapa,
    valorAtual: novoValor,
    limite: novoLimite,
    edicao
  };

  renderizarDetalhesModalResolucaoAlerta(alertaPendenteResolucao);
  alternarModoEdicaoAlerta(false);
  renderizarListaAlertasDOM(alertasAtivosAPI.length ? alertasAtivosAPI : ultimosAlertasBrutos);
  if (typeof renderMovements === "function") {
    renderMovements();
  }
  if (typeof atualizarBadgesFluxoConvencional === "function") {
    atualizarBadgesFluxoConvencional();
  }

  if (typeof mostrarToast === "function") {
    mostrarToast(
      isEn
        ? `Alert updated for ${alertaPendenteResolucao.placa || "vehicle"}.`
        : `Edição salva para ${alertaPendenteResolucao.placa || "veículo"}.`
    );
  }
}

function abrirModalConfirmacaoResolucaoAlerta(alertaInfo) {
  if (!alertaInfo) return;
  alertaPendenteResolucao = alertaInfo;
  const modal = document.getElementById("confirm-resolve-alert-modal");
  if (!modal) {
    confirmarResolucaoAlertaPendente();
    return;
  }

  const titleEl = document.getElementById("confirm-resolve-alert-title");
  const descEl = document.getElementById("confirm-resolve-alert-desc");
  const badgeEl = modal.querySelector(".modal-resolver-alerta__badge");
  const cancelBtn = document.getElementById("confirm-resolve-alert-cancel");
  const editBtn = document.getElementById("confirm-resolve-alert-edit");
  const submitBtn = document.getElementById("confirm-resolve-alert-submit");

  if (badgeEl) {
    badgeEl.textContent =
      idiomaAtual === "en-US"
        ? "CONFIRMATION · ALERT RESOLUTION"
        : "CONFIRMAÇÃO · RESOLUÇÃO DE ALERTA";
  }
  if (titleEl) {
    titleEl.textContent =
      idiomaAtual === "en-US"
        ? "Resolve this operational alert?"
        : "Deseja resolver este alerta operacional?";
  }
  if (descEl) {
    descEl.textContent =
      idiomaAtual === "en-US"
        ? "Confirm dismissing this alert from Overview. It will remain hidden across automatic updates."
        : "Confirme a baixa deste alerta na Visão Geral. Ele permanecerá oculto mesmo após atualizações automáticas.";
  }
  if (cancelBtn) {
    cancelBtn.textContent = idiomaAtual === "en-US" ? "Cancel" : "Cancelar";
  }
  if (editBtn) {
    editBtn.textContent = idiomaAtual === "en-US" ? "Edit" : "Editar";
  }
  if (submitBtn) {
    submitBtn.textContent =
      idiomaAtual === "en-US" ? "Confirm resolution" : "Confirmar resolução";
  }

  renderizarDetalhesModalResolucaoAlerta(alertaInfo);
  alternarModoEdicaoAlerta(false);

  if (typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute("open", "");
  }
}

function fecharModalConfirmacaoResolucaoAlerta() {
  const modal = document.getElementById("confirm-resolve-alert-modal");
  if (modal) {
    if (typeof modal.close === "function" && modal.open) {
      modal.close();
    } else {
      modal.removeAttribute("open");
    }
  }
  alertaPendenteResolucao = null;
}

function confirmarResolucaoAlertaPendente() {
  if (!alertaPendenteResolucao) return;
  const { chave, tipo, placa, etapa, valorAtual } = alertaPendenteResolucao;
  if (chave) {
    alertasResolvidosLocal.add(chave);
    salvarAlertasResolvidosLocal();
    alertasResolvidosMetaLocal[chave] = {
      tipo: tipo || "",
      placa: placa || "",
      etapa: etapa || "",
      valorAtual: valorAtual || ""
    };
    salvarAlertasResolvidosMetaLocal();
  }
  fecharModalConfirmacaoResolucaoAlerta();
  renderizarListaAlertasDOM(alertasAtivosAPI.length ? alertasAtivosAPI : ultimosAlertasBrutos);
  if (typeof renderMovements === "function") {
    renderMovements();
  }
  if (typeof mostrarToast === "function") {
    mostrarToast(
      idiomaAtual === "en-US"
        ? `Alert resolved for ${placa || "vehicle"}.`
        : `Alerta resolvido para ${placa || "veículo"}.`
    );
  }
}

function fecharModalRestaurarAlertas() {
  const modal = document.getElementById("restore-alerts-modal");
  if (!modal) return;
  if (typeof modal.close === "function" && modal.open) {
    modal.close();
  } else {
    modal.removeAttribute("open");
  }
}

function renderizarListaRestaurarAlertas() {
  const listaEl = document.getElementById("restore-alerts-list");
  if (!listaEl) return;

  const isEn = idiomaAtual === "en-US";
  const chaves = Array.from(alertasResolvidosLocal);
  const btnAll = document.getElementById("restore-all-alerts-submit");
  if (btnAll) {
    btnAll.disabled = chaves.length === 0;
  }

  if (!chaves.length) {
    listaEl.innerHTML = `<p class="modal-confirmar-exclusao__desc">${
      isEn ? "No resolved alerts at the moment." : "Nenhum alerta resolvido no momento."
    }</p>`;
    return;
  }

  const fonteAlertas = (alertasAtivosAPI && alertasAtivosAPI.length) ? alertasAtivosAPI : (ultimosAlertasBrutos || []);
  const fonteVeiculos = typeof obterFonteVeiculosCompleta === "function" ? obterFonteVeiculosCompleta() : [];

  listaEl.innerHTML = chaves
    .map(chave => {
      const meta = alertasResolvidosMetaLocal[chave] || null;
      const edicao = alertasEditadosLocal?.[chave] || null;
      const alertaBruto = fonteAlertas.find(a => obterChaveUnicaAlerta(a) === chave) || null;
      const placa =
        meta?.placa ||
        (alertaBruto && typeof alertaBruto === "object" ? (alertaBruto.placa ?? alertaBruto.plate) : "") ||
        (chave.includes("::") ? chave.split("::")[1] : "") ||
        "—";

      const placaNorm = normalizarTexto(placa);
      const veiculoRel = placaNorm
        ? fonteVeiculos.find(v => normalizarTexto(v.plate) === placaNorm)
        : null;

      const etapaBruta =
        edicao?.etapa ||
        meta?.etapa ||
        (alertaBruto && typeof alertaBruto === "object" ? (alertaBruto.etapa_atual ?? alertaBruto.etapa) : "") ||
        veiculoRel?.stage ||
        "";

      const itemParaExibicao = {
        ...(veiculoRel || {}),
        flow:
          (alertaBruto && typeof alertaBruto === "object"
            ? (alertaBruto.flow ?? alertaBruto.destino ?? alertaBruto.berco ?? alertaBruto.berco_destino)
            : "") ||
          veiculoRel?.flow ||
          veiculoRel?.destino ||
          "",
        operation:
          (alertaBruto && typeof alertaBruto === "object"
            ? (alertaBruto.operacao ?? alertaBruto.operation)
            : "") ||
          veiculoRel?.operation ||
          "",
        stage: etapaBruta
      };

      const ehRetencao =
        chave.startsWith("RETENCAO_PRC::") ||
        /reten[çc][ãa]o|prc/i.test(meta?.tipo || edicao?.tipo || "");

      let tipoExibido = obterNomeTipoAlertaPorChave(chave, edicao || meta);
      if (ehRetencao) {
        const rotuloRetencao = formatarRotuloAlertaParaExibicao(itemParaExibicao, {
          rotulo: "Retenção PRC",
          tipo: "RETENCAO_PRC"
        });
        if (rotuloRetencao === "Retenção Gate in") {
          tipoExibido = isEn ? "GATE IN RETENTION" : "RETENÇÃO GATE IN";
        }
      }

      const etapaExibida =
        etapaBruta && etapaBruta !== "—"
          ? formatarRotuloEtapaParaExibicao({ ...itemParaExibicao, stage: etapaBruta }) || etapaBruta
          : "";

      const valorExibido =
        edicao?.valorAtual ||
        meta?.valorAtual ||
        (alertaBruto && typeof alertaBruto === "object" && alertaBruto.valor_atual !== undefined && alertaBruto.valor_atual !== null
          ? String(alertaBruto.valor_atual)
          : "");

      const partesMeta = [placa, etapaExibida, valorExibido].filter(v => v && v !== "—");
      const metaTexto = partesMeta.length ? partesMeta.join(" · ") : (placa || "—");

      return `
        <div class="modal-restaurar-alertas__item">
          <div class="modal-restaurar-alertas__info">
            <strong class="modal-restaurar-alertas__titulo">${escaparHtml(tipoExibido)}</strong>
            <span class="modal-restaurar-alertas__meta">${escaparHtml(metaTexto)}</span>
          </div>
          <button
            type="button"
            class="botao botao--claro modal-restaurar-alertas__btn"
            data-action="restore-single-alert"
            data-alert-key="${escaparHtml(chave)}"
          >${escaparHtml(isEn ? "Restore" : "Restaurar")}</button>
        </div>
      `;
    })
    .join("");
}

function abrirModalRestaurarAlertas() {
  const modal = document.getElementById("restore-alerts-modal");
  if (!modal) {
    restaurarAlertasResolvidos();
    return;
  }

  const isEn = idiomaAtual === "en-US";
  const badgeEl = document.getElementById("restore-alerts-badge");
  const titleEl = document.getElementById("restore-alerts-title");
  const descEl = document.getElementById("restore-alerts-desc");
  const closeBtn = document.getElementById("restore-alerts-close");
  const allBtn = document.getElementById("restore-all-alerts-submit");

  if (badgeEl) badgeEl.textContent = isEn ? "RESTORE · RESOLVED ALERTS" : "RESTAURAÇÃO · ALERTAS RESOLVIDOS";
  if (titleEl) titleEl.textContent = isEn ? "Restore resolved alerts" : "Restaurar alertas resolvidos";
  if (descEl) {
    descEl.textContent = isEn
      ? "Select individually which alert to reactivate or restore all at once."
      : "Selecione individualmente qual alerta deseja reativar ou restaure todos de uma vez.";
  }
  if (closeBtn) closeBtn.textContent = isEn ? "Close" : "Fechar";
  if (allBtn) allBtn.textContent = isEn ? "Restore all" : "Restaurar todos";

  renderizarListaRestaurarAlertas();

  if (typeof modal.showModal === "function") {
    if (!modal.open) {
      modal.showModal();
    }
  } else {
    modal.setAttribute("open", "");
  }
}

function restaurarAlertaResolvidoPorChave(chave) {
  if (!chave || !alertasResolvidosLocal.has(chave)) return;

  const meta = alertasResolvidosMetaLocal[chave] || null;
  alertasResolvidosLocal.delete(chave);
  delete alertasResolvidosMetaLocal[chave];
  salvarAlertasResolvidosLocal();
  salvarAlertasResolvidosMetaLocal();

  renderizarListaAlertasDOM(alertasAtivosAPI.length ? alertasAtivosAPI : ultimosAlertasBrutos);
  if (typeof renderMovements === "function") {
    renderMovements();
  }
  renderizarListaRestaurarAlertas();

  if (alertasResolvidosLocal.size === 0) {
    fecharModalRestaurarAlertas();
  }

  if (typeof mostrarToast === "function") {
    const placa = meta?.placa || (chave.includes("::") ? chave.split("::")[1] : "");
    mostrarToast(
      idiomaAtual === "en-US"
        ? `Alert restored for ${placa || "vehicle"}.`
        : `Alerta restaurado para ${placa || "veículo"}.`
    );
  }
}

function restaurarAlertasResolvidos() {
  alertasResolvidosLocal.clear();
  alertasResolvidosMetaLocal = {};
  salvarAlertasResolvidosLocal();
  salvarAlertasResolvidosMetaLocal();
  renderizarListaAlertasDOM(alertasAtivosAPI.length ? alertasAtivosAPI : ultimosAlertasBrutos);
  if (typeof renderMovements === "function") {
    renderMovements();
  }
  if (typeof mostrarToast === "function") {
    mostrarToast(
      idiomaAtual === "en-US"
        ? "Resolved alerts restored."
        : "Alertas resolvidos restaurados."
    );
  }
}

const restoreAlertsModalEl = document.getElementById("restore-alerts-modal");
const restoreAlertsListEl = document.getElementById("restore-alerts-list");
const restoreAlertsCloseBtn = document.getElementById("restore-alerts-close");
const restoreAllAlertsSubmitBtn = document.getElementById("restore-all-alerts-submit");

if (restoreAlertsCloseBtn) {
  restoreAlertsCloseBtn.addEventListener("click", fecharModalRestaurarAlertas);
}

if (restoreAllAlertsSubmitBtn) {
  restoreAllAlertsSubmitBtn.addEventListener("click", () => {
    restaurarAlertasResolvidos();
    fecharModalRestaurarAlertas();
  });
}

if (restoreAlertsListEl) {
  restoreAlertsListEl.addEventListener("click", event => {
    const btn = event.target.closest('[data-action="restore-single-alert"]');
    if (!btn) return;
    const chave = btn.getAttribute("data-alert-key") || "";
    if (chave) {
      restaurarAlertaResolvidoPorChave(chave);
    }
  });
}

if (restoreAlertsModalEl) {
  restoreAlertsModalEl.addEventListener("click", event => {
    if (event.target === restoreAlertsModalEl) {
      fecharModalRestaurarAlertas();
    }
  });
  restoreAlertsModalEl.addEventListener("cancel", () => {
    fecharModalRestaurarAlertas();
  });
}

const confirmResolveAlertModalEl = document.getElementById("confirm-resolve-alert-modal");
const confirmResolveAlertSubmitBtn = document.getElementById("confirm-resolve-alert-submit");
const confirmResolveAlertCancelBtn = document.getElementById("confirm-resolve-alert-cancel");
const confirmResolveAlertEditBtn = document.getElementById("confirm-resolve-alert-edit");
const confirmResolveAlertBackBtn = document.getElementById("confirm-resolve-alert-back");
const confirmResolveAlertSaveBtn = document.getElementById("confirm-resolve-alert-save");

if (confirmResolveAlertSubmitBtn) {
  confirmResolveAlertSubmitBtn.addEventListener("click", confirmarResolucaoAlertaPendente);
}

if (confirmResolveAlertCancelBtn) {
  confirmResolveAlertCancelBtn.addEventListener("click", fecharModalConfirmacaoResolucaoAlerta);
}

if (confirmResolveAlertEditBtn) {
  confirmResolveAlertEditBtn.addEventListener("click", () => alternarModoEdicaoAlerta(true));
}

if (confirmResolveAlertBackBtn) {
  confirmResolveAlertBackBtn.addEventListener("click", () => alternarModoEdicaoAlerta(false));
}

if (confirmResolveAlertSaveBtn) {
  confirmResolveAlertSaveBtn.addEventListener("click", salvarEdicaoAlertaPendente);
}

if (confirmResolveAlertModalEl) {
  confirmResolveAlertModalEl.addEventListener("click", event => {
    if (event.target === confirmResolveAlertModalEl) {
      fecharModalConfirmacaoResolucaoAlerta();
    }
  });
  confirmResolveAlertModalEl.addEventListener("cancel", () => {
    alertaPendenteResolucao = null;
  });
}

function obterEdicoesAlertaPorPlaca(placa) {
  const placaNorm = normalizarTexto(placa);
  if (!placaNorm || !alertasEditadosLocal || typeof alertasEditadosLocal !== "object") {
    return [];
  }
  const sufixo = `::${placaNorm}`;
  return Object.entries(alertasEditadosLocal)
    .filter(([chave, edicao]) => chave.endsWith(sufixo) && edicao && typeof edicao === "object")
    .map(([chave, edicao]) => ({ chave, edicao }));
}

function obterNomeTipoAlertaPorChave(chave, edicao) {
  if (edicao?.tipo) return edicao.tipo;
  if (chave.startsWith("SOBREPESO::")) return "EXCESSO DE PESO NA BALANÇA";
  if (chave.startsWith("RETENCAO_PRC::")) return "RETENÇÃO NO PÁTIO PRC";
  return "ALERTA OPERACIONAL";
}

function abrirModalHistoricoEdicaoAlerta(placa) {
  const modal = document.getElementById("alert-edit-history-modal");
  const bodyEl = document.getElementById("alert-edit-history-body");
  if (!modal || !bodyEl) return;

  const isEn = idiomaAtual === "en-US";
  const badgeEl = document.getElementById("alert-edit-history-badge");
  const titleEl = document.getElementById("alert-edit-history-title");
  const closeBtn = document.getElementById("alert-edit-history-close");

  if (badgeEl) {
    badgeEl.textContent = isEn ? "HISTORY · EDITED ALERT" : "HISTÓRICO · ALERTA EDITADO";
  }
  if (titleEl) {
    titleEl.textContent = isEn ? "Recorded alert changes" : "Alterações registradas no alerta";
  }
  if (closeBtn) {
    closeBtn.textContent = isEn ? "Close" : "Fechar";
  }

  const edicoes = obterEdicoesAlertaPorPlaca(placa);
  if (!edicoes.length) {
    bodyEl.innerHTML = `<p class="modal-confirmar-exclusao__desc">${
      isEn ? "No edits recorded for this vehicle." : "Nenhuma edição registrada para este veículo."
    }</p>`;
  } else {
    bodyEl.innerHTML = edicoes
      .map(({ chave, edicao }) => {
        const tipoAlerta = obterNomeTipoAlertaPorChave(chave, edicao);
        const alteracoesLista = Array.isArray(edicao.alteracoes)
          ? edicao.alteracoes.filter(a => !String(a).startsWith("Obs:"))
          : [];
        const itensHtml = alteracoesLista.length
          ? alteracoesLista.map(item => `<li>${escaparHtml(item)}</li>`).join("")
          : `<li>${isEn ? "Values updated" : "Valores atualizados"}</li>`;
        const obsHtml = edicao.observacao
          ? `<p class="modal-historico-edicao__obs"><strong>${
              isEn ? "Note:" : "Observação:"
            }</strong> ${escaparHtml(edicao.observacao)}</p>`
          : "";
        return `
          <div class="modal-historico-edicao__bloco">
            <div class="modal-historico-edicao__cabecalho">
              <span class="modal-historico-edicao__tipo">${escaparHtml(tipoAlerta)}</span>
              <span class="modal-historico-edicao__placa">${escaparHtml(placa)}</span>
            </div>
            <ul class="modal-historico-edicao__lista">${itensHtml}</ul>
            ${obsHtml}
          </div>
        `;
      })
      .join("");
  }

  if (typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute("open", "");
  }
}

function fecharModalHistoricoEdicaoAlerta() {
  const modal = document.getElementById("alert-edit-history-modal");
  if (!modal) return;
  if (typeof modal.close === "function" && modal.open) {
    modal.close();
  } else {
    modal.removeAttribute("open");
  }
}

const alertEditHistoryModalEl = document.getElementById("alert-edit-history-modal");
const alertEditHistoryCloseBtn = document.getElementById("alert-edit-history-close");

if (alertEditHistoryCloseBtn) {
  alertEditHistoryCloseBtn.addEventListener("click", fecharModalHistoricoEdicaoAlerta);
}

if (alertEditHistoryModalEl) {
  alertEditHistoryModalEl.addEventListener("click", event => {
    if (event.target === alertEditHistoryModalEl) {
      fecharModalHistoricoEdicaoAlerta();
    }
  });
}

const movementRowsEl = document.getElementById("movement-rows");
if (movementRowsEl) {
  movementRowsEl.addEventListener("click", event => {
    const btnTicket = event.target.closest(".link-placa-ticket");
    if (btnTicket) {
      const placaTicket = btnTicket.dataset.ticketPlate || btnTicket.textContent || "";
      abrirModalDetalhesTicket(placaTicket.trim());
      return;
    }

    const btn = event.target.closest(".btn-remover-registro");
    if (!btn) return;
    const chave = btn.dataset.removeKey || btn.dataset.removePlate || "";
    const isLocal = btn.dataset.removeLocal === "true";
    const placa = btn.dataset.removePlate || chave;
    const carrier = btn.dataset.removeCarrier || "";
    abrirModalConfirmacaoExclusao(chave, isLocal, placa, carrier);
  });
}

const ticketModalEl = document.getElementById("ticket-details-modal");
const ticketCloseBtn = document.getElementById("ticket-modal-close");
const ticketCloseIconBtn = document.getElementById("ticket-modal-close-icon");
const ticketCopyBtn = document.getElementById("ticket-modal-copy-summary");

if (ticketCopyBtn) {
  ticketCopyBtn.addEventListener("click", copiarResumoTicketModal);
}

if (ticketCloseBtn) {
  ticketCloseBtn.addEventListener("click", fecharModalDetalhesTicket);
}

if (ticketCloseIconBtn) {
  ticketCloseIconBtn.addEventListener("click", fecharModalDetalhesTicket);
}

if (
  ticketModalEl &&
  typeof HTMLDialogElement !== "undefined" &&
  !("closedBy" in HTMLDialogElement.prototype)
) {
  ticketModalEl.addEventListener("click", event => {
    if (event.target !== ticketModalEl) return;
    const rect = ticketModalEl.getBoundingClientRect();
    const isDialogContent =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (isDialogContent) return;
    fecharModalDetalhesTicket();
  });
}

const btnRestaurarRemovidos = document.getElementById("btn-restaurar-removidos");
if (btnRestaurarRemovidos) {
  btnRestaurarRemovidos.addEventListener("click", () => {
    abrirModalRestauracao();
  });
}

const localVehiclesListEl = document.getElementById("local-vehicles-list");
if (localVehiclesListEl) {
  localVehiclesListEl.addEventListener("click", event => {
    const btn = event.target.closest("[data-remove-local-plate]");
    if (!btn) return;
    const placa = btn.dataset.removeLocalPlate || "";
    removerVeiculoLocal(placa, true);
  });
}

const btnLimparVeiculosLocais = document.getElementById("btn-limpar-veiculos-locais");
if (btnLimparVeiculosLocais) {
  btnLimparVeiculosLocais.addEventListener("click", () => {
    limparVeiculosLocais();
  });
}

const restoreModalEl = document.getElementById("restore-vehicles-modal") || document.getElementById("restore-deleted-modal");
const restoreCancelEl = document.getElementById("restore-vehicles-cancel");
const restoreAllSubmitEl = document.getElementById("restore-all-vehicles-submit");
const restoreVehiclesListEl = document.getElementById("restore-vehicles-list");

if (restoreCancelEl) {
  restoreCancelEl.addEventListener("click", fecharModalRestauracao);
}

if (restoreAllSubmitEl) {
  restoreAllSubmitEl.addEventListener("click", () => {
    restaurarVeiculosRemovidos();
  });
}

if (restoreVehiclesListEl) {
  restoreVehiclesListEl.addEventListener("click", event => {
    const btn = event.target.closest("[data-restore-index]");
    if (!btn) return;
    const indice = Number(btn.dataset.restoreIndex);
    restaurarVeiculoPorIndice(indice);
  });
}

if (restoreModalEl) {
  restoreModalEl.addEventListener("click", event => {
    if (event.target === restoreModalEl) {
      fecharModalRestauracao();
    }
  });
}

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (restoreModalEl && !restoreModalEl.hidden) {
    fecharModalRestauracao();
  }
  if (ticketModalEl && ticketModalEl.hasAttribute("open")) {
    fecharModalDetalhesTicket();
  }
  if (reportModalEl && reportModalEl.hasAttribute("open")) {
    fecharModalDetalhesRelatorio();
  }
});

let instanciaFlowChart = null;

function extrairHoraVeiculo(v) {
  if (!v || typeof v !== "object") return null;
  const campos = [
    v.entry,
    v.horario_entrada,
    v.dataMovimentacao,
    v.DataMovimentacao,
    v.data_movimentacao,
    v.entryPAN,
    v.entrada_pan,
    v.data_entrada
  ];

  for (const val of campos) {
    if (typeof val === "string" && val.trim() && val !== "—") {
      const str = val.trim();
      const matchHora = str.match(/(?:^|\s+|T)(\d{1,2}):(\d{2})/);
      if (matchHora) {
        const hora = parseInt(matchHora[1], 10);
        if (hora >= 0 && hora <= 23) {
          return hora;
        }
      }
    } else if (val instanceof Date && !isNaN(val.getTime())) {
      return val.getHours();
    }
  }
  return null;
}

function calcularDistribuicaoFluxoHorario() {
  const lista = (typeof obterFonteVeiculosCompleta === "function")
    ? obterFonteVeiculosCompleta()
    : [];

  const contagens = new Array(12).fill(0);

  lista.forEach(v => {
    const hora = extrairHoraVeiculo(v);
    if (hora !== null && hora >= 0 && hora < 24) {
      const bucket = Math.floor(hora / 2);
      contagens[bucket]++;
    }
  });

  return contagens;
}

function atualizarGraficoFluxoOverview() {
  const chartCanvas = document.getElementById("flowChart");
  if (!chartCanvas) return;

  if (!window.Chart) {
    chartCanvas.parentElement.innerHTML =
      "<p>Para visualizar o gráfico, conecte-se à internet para carregar a biblioteca Chart.js.</p>";
    return;
  }

  const contagens = calcularDistribuicaoFluxoHorario();
  const maxContagem = Math.max(...contagens, 0);
  const rotuloDataset = idiomaAtual === "en-US" ? "Vehicles" : "Veículos";

  if (instanciaFlowChart) {
    instanciaFlowChart.data.datasets[0].label = rotuloDataset;
    instanciaFlowChart.data.datasets[0].data = contagens;
    if (instanciaFlowChart.options?.scales?.y) {
      instanciaFlowChart.options.scales.y.suggestedMax = Math.max(maxContagem + 1, 4);
    }
    instanciaFlowChart.update();
    return;
  }

  instanciaFlowChart = new Chart(chartCanvas, {
    type: "line",
    data: {
      labels: [
        "00h", "02h", "04h", "06h",
        "08h", "10h", "12h", "14h",
        "16h", "18h", "20h", "22h"
      ],
      datasets: [
        {
          label: rotuloDataset,
          data: contagens,
          borderColor: "#1877f2",
          backgroundColor: "rgba(24,119,242,.10)",
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            title: function(items) {
              if (!items || !items.length) return "";
              const idx = items[0].dataIndex;
              const horaInicio = (idx * 2).toString().padStart(2, "0") + "h";
              const horaFim = ((idx + 1) * 2).toString().padStart(2, "0") + "h";
              return `${horaInicio} – ${horaFim}`;
            },
            label: function(context) {
              const valor = context.parsed.y ?? 0;
              const rotulo = (idiomaAtual === "en-US")
                ? (valor === 1 ? "1 vehicle" : `${valor} vehicles`)
                : (valor === 1 ? "1 veículo" : `${valor} veículos`);
              return ` ${rotulo}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: "#8093ad",
            font: {
              size: 9
            }
          }
        },
        y: {
          beginAtZero: true,
          suggestedMax: Math.max(maxContagem + 1, 4),
          grid: {
            color: "#edf2f9"
          },
          ticks: {
            precision: 0,
            color: "#8093ad",
            font: {
              size: 9
            }
          }
        }
      }
    }
  });
}

atualizarGraficoFluxoOverview();

/* =========================================
   SELETOR DE IDIOMA E INICIALIZAÇÃO
========================================= */

function atualizarNotaResumoConfiguracoes() {
  const summaryEl = document.getElementById("settings-active-summary");
  const inputSobrepeso = document.getElementById("config-overweight-limit");
  const inputPrc = document.getElementById("config-prc-limit");
  const inputPolling = document.getElementById("config-polling-interval");

  const cfg = configOperacionalCCO || carregarConfigOperacionalStorage();

  if (inputSobrepeso && (!document.activeElement || document.activeElement !== inputSobrepeso)) {
    inputSobrepeso.value = cfg.limiteSobrepesoKg;
  }
  if (inputPrc && (!document.activeElement || document.activeElement !== inputPrc)) {
    inputPrc.value = cfg.limiteRetencaoPrcMin;
  }
  if (inputPolling && (!document.activeElement || document.activeElement !== inputPolling)) {
    inputPolling.value = cfg.intervaloPollingSeg;
  }

  if (summaryEl) {
    const sobrepesoFmt = typeof formatarNumero === "function" ? formatarNumero(cfg.limiteSobrepesoKg, 0) : cfg.limiteSobrepesoKg.toLocaleString("pt-BR");
    if (idiomaAtual === "en-US") {
      summaryEl.textContent = `Active operational parameters: Overweight > ${sobrepesoFmt} kg · PRC Retention > ${cfg.limiteRetencaoPrcMin} min · Polling: ${cfg.intervaloPollingSeg}s`;
    } else {
      summaryEl.textContent = `Parâmetros operacionais ativos: Sobrepeso > ${sobrepesoFmt} kg · Retenção PRC > ${cfg.limiteRetencaoPrcMin} min · Polling: ${cfg.intervaloPollingSeg}s`;
    }
  }
}

function inicializarConfiguracoesOperacionais() {
  const btnSalvar = document.getElementById("btn-save-settings");
  const btnSync = document.getElementById("btn-sync-settings");
  const btnReset = document.getElementById("btn-reset-settings");

  if (btnSalvar) {
    btnSalvar.addEventListener("click", () => {
      const inputSobrepeso = document.getElementById("config-overweight-limit");
      const inputPrc = document.getElementById("config-prc-limit");
      const inputPolling = document.getElementById("config-polling-interval");

      const sobrepeso = Number(inputSobrepeso?.value) || CONFIG_OPERACIONAL_PADRAO.limiteSobrepesoKg;
      const prc = Number(inputPrc?.value) || CONFIG_OPERACIONAL_PADRAO.limiteRetencaoPrcMin;
      const polling = Math.max(5, Number(inputPolling?.value) || CONFIG_OPERACIONAL_PADRAO.intervaloPollingSeg);

      configOperacionalCCO = {
        limiteSobrepesoKg: sobrepeso,
        limiteRetencaoPrcMin: prc,
        intervaloPollingSeg: polling
      };
      salvarConfigOperacionalStorage(configOperacionalCCO);
      INTERVALO_ATUALIZACAO_MS = polling * 1000;

      atualizarNotaResumoConfiguracoes();
      if (typeof notify === "function") {
        const msg = t("settings.saved_msg")
          .replace("{overweight}", typeof formatarNumero === "function" ? formatarNumero(sobrepeso, 0) : sobrepeso)
          .replace("{prc}", prc)
          .replace("{polling}", polling);
        notify(msg);
      }
      sincronizarTodosEndpoints();
    });
  }

  if (btnSync) {
    btnSync.addEventListener("click", async () => {
      if (btnSync.disabled) return;

      const textoOriginal = btnSync.innerHTML;
      btnSync.disabled = true;
      btnSync.classList.add("configuracao__botao-acao--girando");
      btnSync.innerHTML = `<span class="configuracao__icone-giro">↻</span> ${idiomaAtual === "en-US" ? "Syncing..." : "Sincronizando..."}`;

      const msgSincronizando = idiomaAtual === "en-US" ? "↻ Syncing with FastAPI API..." : "↻ Sincronizando com a API FastAPI...";
      notify(msgSincronizando, "sincronizando", 0);

      const delayMinimo = new Promise(resolve => setTimeout(resolve, 600));

      let online = false;
      try {
        const [resultadoSync] = await Promise.all([
          sincronizarTodosEndpoints(),
          delayMinimo
        ]);
        online = resultadoSync === true || (resultadoSync !== false && apiConectada);
      } catch (err) {
        console.error("Erro na sincronização manual:", err);
        online = false;
      } finally {
        btnSync.disabled = false;
        btnSync.classList.remove("configuracao__botao-acao--girando");
        btnSync.innerHTML = textoOriginal;
      }

      if (online) {
        atualizarStatusConexaoUI(true);
        const msgSucesso = idiomaAtual === "en-US"
          ? "✓ Successfully synchronized with FastAPI API!"
          : "✓ Sincronizado com sucesso com a API FastAPI!";
        notify(msgSucesso, "sucesso", 2800);
      } else {
        atualizarStatusConexaoUI(false);
        const msgFalha = idiomaAtual === "en-US"
          ? "⚠ Failed to sync with API (contingency mode active)."
          : "⚠ Falha ao sincronizar com a API (modo contingência ativo).";
        notify(msgFalha, "erro", 2800);
      }
    });
  }

  if (btnReset) {
    btnReset.addEventListener("click", () => {
      configOperacionalCCO = { ...CONFIG_OPERACIONAL_PADRAO };
      salvarConfigOperacionalStorage(configOperacionalCCO);
      INTERVALO_ATUALIZACAO_MS = CONFIG_OPERACIONAL_PADRAO.intervaloPollingSeg * 1000;
      atualizarNotaResumoConfiguracoes();
      if (typeof notify === "function") {
        notify(t("settings.reset_msg"));
      }
      sincronizarTodosEndpoints();
    });
  }

  atualizarNotaResumoConfiguracoes();
}

const languageSelectEl = document.getElementById("language-select");
if (languageSelectEl) {
  languageSelectEl.value = idiomaAtual;
  languageSelectEl.addEventListener("change", () => {
    aplicarIdiomaUI(languageSelectEl.value);
  });
}

/* =========================================
   FLUXOS OPERACIONAIS · COPI (ABAS INTERNAS)
========================================= */

function atualizarBadgesFluxoConvencional(veiculosLista) {
  const painel = document.getElementById("painel-fluxo-convencional");
  if (!painel) return;

  const todosVeiculos = Array.isArray(veiculosLista)
    ? veiculosLista
    : (typeof obterFonteVeiculosCompleta === "function" ? obterFonteVeiculosCompleta() : []);

  const contagensEtapas = {
    prc: todosVeiculos.filter(v => coincidirEtapa(v.stage, "Fila PRC") || coincidirEtapa(v.stage, "Pátio")).length,
    funil: todosVeiculos.filter(v => coincidirEtapa(v.stage, "Operação")).length,
    balanca: todosVeiculos.filter(v => coincidirEtapa(v.stage, "Balança Tara") || coincidirEtapa(v.stage, "Balança Bruto")).length,
    pan_saida: todosVeiculos.filter(v => coincidirEtapa(v.stage, "PAN")).length
  };

  painel.querySelectorAll(".fluxo-etapa[data-fluxo-etapa]").forEach(node => {
    const etapaId = node.getAttribute("data-fluxo-etapa");
    const badge =
      node.querySelector(`.fluxo-etapa__qtd[data-fluxo-qtd="${etapaId}"]`) ||
      node.querySelector(".fluxo-etapa__qtd");
    if (!badge) return;

    if (Object.prototype.hasOwnProperty.call(contagensEtapas, etapaId)) {
      badge.textContent = String(contagensEtapas[etapaId]);
      badge.hidden = false;
    } else {
      badge.textContent = "";
      badge.hidden = true;
    }
  });
}

function atualizarRitmoBerco101FluxoMecanizado(pontosOperacionais) {
  const badge = document.getElementById("fluxo-mecanizado-ritmo-b101");
  if (!badge) return;

  const lista = Array.isArray(pontosOperacionais) && pontosOperacionais.length
    ? pontosOperacionais
    : (Array.isArray(ultimosBercosAPI) ? ultimosBercosAPI : []);

  const itemB101 = lista.find(p => coincidirDestino(p?.berco_destino ?? p?.nome, "Berço 101"));

  let prancha = null;
  let meta = 458;

  if (itemB101) {
    prancha = itemB101.prancha_atual_th ?? itemB101.prancha_th ?? null;
    meta = itemB101.meta_contratual_th ?? itemB101.meta_th ?? 458;
  } else {
    const cardB101 = document.querySelector('.grade-bercos .berco[data-berco-filter="Berço 101"]');
    if (cardB101) {
      const prodTxt = cardB101.querySelector(".berco__produtividade strong")?.textContent || "";
      const metaTxt = cardB101.querySelector(".berco__referencia strong")?.textContent || "";
      const prodNum = Number(prodTxt.replace(/[^\d.,]/g, "").replace(",", "."));
      const metaNum = Number(metaTxt.replace(/[^\d.,]/g, "").replace(",", "."));
      if (Number.isFinite(prodNum) && prodTxt.trim()) prancha = prodNum;
      if (Number.isFinite(metaNum) && metaNum > 0) meta = metaNum;
    }
  }

  const pranchaStr = prancha !== null && Number.isFinite(Number(prancha))
    ? formatarNumero(Number(prancha), 0)
    : "--";
  const metaStr = formatarNumero(Number(meta) || 458, 0);

  badge.textContent =
    idiomaAtual === "en-US"
      ? `Berth 101 current rate: ${pranchaStr} t/h · Target: ${metaStr} t/h`
      : `Ritmo atual Berço 101: ${pranchaStr} t/h · Meta: ${metaStr} t/h`;
}

function atualizarPranchaExpedicaoFluxo() {
  const badge = document.getElementById("fluxo-expedicao-prancha");
  if (badge) {
    badge.textContent =
      idiomaAtual === "en-US"
        ? "Rate: 250 t/h (Urea: 200 t/h)"
        : "Prancha: 250 t/h (Ureia: 200 t/h)";
  }
}

function atualizarBotaoFluxoExpedicao(veiculosLista) {
  const btn = document.getElementById("btn-fluxo-expedicao-veiculos");
  if (!btn) return;

  const todosVeiculos = Array.isArray(veiculosLista)
    ? veiculosLista
    : (typeof obterFonteVeiculosCompleta === "function" ? obterFonteVeiculosCompleta() : []);

  const chavesVistas = new Set();
  const qtdExpedicao = todosVeiculos.filter(item => {
    if (!coincidirDestino(item?.flow, "Expedição")) return false;
    const chave = obterChaveRegistroVeiculo(item) || normalizarTexto(item?.plate);
    if (!chave) return true;
    if (chavesVistas.has(chave)) return false;
    chavesVistas.add(chave);
    return true;
  }).length;

  btn.textContent =
    idiomaAtual === "en-US"
      ? `Inspect Dispatch vehicles (${qtdExpedicao}) →`
      : `Inspecionar veículos da Expedição (${qtdExpedicao}) →`;
}

function configurarAbasFluxosOperacionais() {
  const container = document.getElementById("bloco-fluxos-operacionais");
  if (!container) return;

  const tabButtons = container.querySelectorAll(".fluxo-aba-btn");
  const tabPanels = container.querySelectorAll(".fluxo-conteudo-aba");

  if (tabButtons.length && tabPanels.length && !container.dataset.fluxosInicializado) {
    container.dataset.fluxosInicializado = "true";
    tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const targetTab = btn.getAttribute("data-tab");
        if (!targetTab) return;

        tabButtons.forEach(b => {
          const isCurrent = b === btn;
          b.classList.toggle("fluxo-aba-btn--ativo", isCurrent);
          b.setAttribute("aria-selected", isCurrent ? "true" : "false");
        });

        tabPanels.forEach(panel => {
          const panelTab = panel.getAttribute("data-tab-content");
          const isTarget = panelTab === targetTab;
          panel.classList.toggle("fluxo-conteudo-aba--ativo", isTarget);
          if (isTarget) {
            panel.removeAttribute("hidden");
          } else {
            panel.setAttribute("hidden", "");
          }
        });
      });
    });
  }

  atualizarBadgesFluxoConvencional();
  atualizarRitmoBerco101FluxoMecanizado();
  atualizarPranchaExpedicaoFluxo();
  atualizarBotaoFluxoExpedicao();
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  configurarAbasFluxosOperacionais();
}

function encerrarSessaoOperador(event) {
  if (event && typeof event.preventDefault === "function") {
    event.preventDefault();
  }
  try {
    localStorage.removeItem("cco_sessao_operador");
    sessionStorage.removeItem("cco_sessao_operador");
  } catch (e) {
    // ignore storage errors
  }
  window.location.href = "login.html";
}

function inicializarSessaoOperadorCabecalho() {
  const avatarEl = document.getElementById("header-user-avatar");
  const nameEl = document.getElementById("header-user-name");
  const roleEl = document.getElementById("header-user-role");
  const logoutLinkEl = document.getElementById("btn-logout-login");
  const settingsUserEl = document.getElementById("settings-session-user");
  const settingsRoleEl = document.getElementById("settings-session-role");
  const settingsLogoutBtn = document.getElementById("btn-logout-settings");

  let sessao = null;
  try {
    const raw =
      localStorage.getItem("cco_sessao_operador") ||
      sessionStorage.getItem("cco_sessao_operador");
    if (raw) {
      sessao = JSON.parse(raw);
    }
  } catch (e) {
    sessao = null;
  }

  if (!sessao || !sessao.usuario) {
    window.location.replace("login.html");
    return;
  }

  const nomeCurto = String(sessao.usuario).split("@")[0];
  if (avatarEl && sessao.iniciais) {
    avatarEl.textContent = sessao.iniciais;
  }
  if (nameEl) {
    nameEl.textContent = nomeCurto;
  }
  if (settingsUserEl) {
    settingsUserEl.textContent = nomeCurto;
  }

  const temUnidadeEspecifica = Boolean(sessao.unidade && sessao.unidade !== "all");
  const textoPerfil = temUnidadeEspecifica
    ? `${t("header.control_center")} · ${sessao.unidade}`
    : t("header.control_center");

  if (roleEl && temUnidadeEspecifica) {
    roleEl.removeAttribute("data-i18n");
    roleEl.textContent = textoPerfil;
  }
  if (settingsRoleEl) {
    if (temUnidadeEspecifica) {
      settingsRoleEl.removeAttribute("data-i18n");
    }
    settingsRoleEl.textContent = textoPerfil;
  }

  if (logoutLinkEl) {
    logoutLinkEl.addEventListener("click", encerrarSessaoOperador);
  }
  if (settingsLogoutBtn) {
    settingsLogoutBtn.addEventListener("click", encerrarSessaoOperador);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  inicializarSessaoOperadorCabecalho();
  aplicarIdiomaUI(idiomaAtual);
  inicializarConfiguracoesOperacionais();
  configurarAbasFluxosOperacionais();
  sincronizarTodosEndpoints();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    clearTimeout(pollingTimeoutId);
    pollingTimeoutId = null;
  } else if (document.visibilityState === "visible") {
    clearTimeout(pollingTimeoutId);
    pollingTimeoutId = null;
    sincronizarTodosEndpoints();
  }
});
