/* =========================================================
   TELA DE LOGIN FLUTUANTE - COPI / CCO
   Compartilha tema claro/escuro ("tema") e idioma ("cco_language") com index.html,
   sincroniza o painel borrado ao fundo e executa transição Fade/Dissolve ao logar.
   ========================================================= */

const STORAGE_KEY_TEMA = "tema";
const STORAGE_KEY_IDIOMA = "cco_language";
const STORAGE_KEY_SESSAO = "cco_sessao_operador";
const STORAGE_KEY_FADE_ENTRADA = "cco_login_fade_transition";

// Dicionário bilíngue (Português / Inglês) para todos os textos da tela de login
const LOGIN_I18N = {
  "pt-BR": {
    "login.page_title": "COPI | Acesso ao Painel Operacional (CCO)",
    "login.lang_aria": "Selecionar idioma",
    "login.theme_aria": "Alternar tema claro e escuro",
    "login.theme_dark": "Tema escuro",
    "login.theme_light": "Tema claro",
    "login.form_title": "Acesso ao Painel CCO",
    "login.form_subtitle": "Informe sua unidade e credenciais operacionais para continuar.",
    "login.unit_label": "Unidade / Empresa",
    "login.unit_all": "Todas as unidades (CCO Geral)",
    "login.user_label": "Operador ou e-mail institucional *",
    "login.user_placeholder": "Ex.: operador.cco ou usuario@emap.ma.gov.br",
    "login.password_label": "Senha de acesso *",
    "login.password_placeholder": "Digite sua senha",
    "login.show_password": "Mostrar senha",
    "login.hide_password": "Ocultar senha",
    "login.remember": "Manter conectado neste terminal",
    "login.forgot": "Esqueci minha senha",
    "login.submit": "Entrar no painel operacional",
    "login.submitting": "Validando acesso...",
    "login.demo_title": "Acesso de demonstração:",
    "login.demo_text": "preencha com operador padrão do CCO.",
    "login.demo_btn": "Preencher CCO",
    "login.modal_tag": "SUPORTE OPERACIONAL · CCO",
    "login.modal_title": "Recuperação de credenciais",
    "login.modal_desc": "Para redefinir sua senha de acesso ao painel CCO, entre em contato com a coordenação de turno ou com a equipe de TI da EMAP informando sua matrícula operacional.",
    "login.modal_close": "Entendido",
    "login.err_user_required": "Informe o identificador do operador ou e-mail institucional.",
    "login.err_pass_required": "Informe sua senha de acesso.",
    "login.err_pass_min": "A senha deve conter pelo menos 4 caracteres.",
    "login.toast_theme_dark": "Tema escuro aplicado.",
    "login.toast_theme_light": "Tema claro aplicado.",
    "login.toast_demo_filled": "Credenciais demonstrativas do CCO preenchidas.",
    "login.toast_success": "Acesso autorizado. Entrando no painel..."
  },
  "en-US": {
    "login.page_title": "COPI | Operational Dashboard Login (OCC)",
    "login.lang_aria": "Select language",
    "login.theme_aria": "Switch between light and dark theme",
    "login.theme_dark": "Dark theme",
    "login.theme_light": "Light theme",
    "login.form_title": "OCC Dashboard Sign In",
    "login.form_subtitle": "Enter your unit and operational credentials to continue.",
    "login.unit_label": "Unit / Company",
    "login.unit_all": "All units (General OCC)",
    "login.user_label": "Operator ID or corporate email *",
    "login.user_placeholder": "e.g. operator.occ or user@emap.ma.gov.br",
    "login.password_label": "Access password *",
    "login.password_placeholder": "Enter your password",
    "login.show_password": "Show password",
    "login.hide_password": "Hide password",
    "login.remember": "Keep signed in on this terminal",
    "login.forgot": "Forgot password",
    "login.submit": "Sign in to operational dashboard",
    "login.submitting": "Signing in...",
    "login.demo_title": "Demo access:",
    "login.demo_text": "fill with default OCC operator credentials.",
    "login.demo_btn": "Fill OCC",
    "login.modal_tag": "OPERATIONAL SUPPORT · OCC",
    "login.modal_title": "Credential recovery",
    "login.modal_desc": "To reset your OCC dashboard password, contact the shift coordinator or EMAP IT support with your operator registration ID.",
    "login.modal_close": "Got it",
    "login.err_user_required": "Please enter your operator ID or corporate email.",
    "login.err_pass_required": "Please enter your password.",
    "login.err_pass_min": "Password must be at least 4 characters long.",
    "login.toast_theme_dark": "Dark theme applied.",
    "login.toast_theme_light": "Light theme applied.",
    "login.toast_demo_filled": "Default OCC demo credentials filled.",
    "login.toast_success": "Access granted. Entering dashboard..."
  }
};

// Lê o idioma salvo no navegador (padrão pt-BR)
function obterIdiomaAtual() {
  try {
    return localStorage.getItem(STORAGE_KEY_IDIOMA) === "en-US" ? "en-US" : "pt-BR";
  } catch (e) {
    return "pt-BR";
  }
}

let idiomaLogin = obterIdiomaAtual();

// Retorna o texto traduzido correspondente à chave informada
function tLogin(key) {
  const dict = LOGIN_I18N[idiomaLogin] || LOGIN_I18N["pt-BR"];
  return dict[key] || LOGIN_I18N["pt-BR"][key] || key;
}

const toastEl = document.getElementById("toast");
let toastTimer = null;

// Exibe notificações visuais no mesmo padrão do painel principal
function notifyLogin(mensagem, tipo = "padrao", duracao = 2800) {
  if (!toastEl) return;
  toastEl.textContent = mensagem;
  toastEl.className = "notificacao notificacao--visivel";

  if (tipo === "sucesso") {
    toastEl.classList.add("notificacao--sucesso");
  } else if (tipo === "erro") {
    toastEl.classList.add("notificacao--erro");
  } else if (tipo === "sincronizando") {
    toastEl.classList.add("notificacao--sincronizando");
  }

  clearTimeout(toastTimer);
  if (duracao > 0) {
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("notificacao--visivel");
    }, duracao);
  }
}

// Sincroniza diretamente a classe tema--escuro no body do iframe de fundo
function sincronizarClasseTemaIframe(isDark) {
  const frameEl = document.getElementById("login-backdrop-frame");
  if (!frameEl) return;
  try {
    if (frameEl.contentDocument && frameEl.contentDocument.body) {
      frameEl.contentDocument.body.classList.toggle("tema--escuro", isDark);
    }
  } catch (e) {
    // Ignora erros de acesso ao DOM do iframe caso ainda esteja carregando
  }
}

// Sincroniza tema e idioma com o painel de controle carregado no iframe ao fundo
function sincronizarPainelFundo(dados) {
  const frameEl = document.getElementById("login-backdrop-frame");
  if (!frameEl || !frameEl.contentWindow) return;
  try {
    frameEl.contentWindow.postMessage(dados, "*");
  } catch (e) {
    // Ignora falhas de comunicação com o iframe caso ainda esteja carregando
  }
}

// Recupera o tema salvo ("light" ou "dark")
function obterTemaAtual() {
  try {
    return localStorage.getItem(STORAGE_KEY_TEMA) === "dark" ? "dark" : "light";
  } catch (e) {
    return "light";
  }
}

// Atualiza o ícone e o rótulo do botão de alternância de tema dentro do card
function atualizarBotaoTemaUI(tema) {
  const isDark = tema === "dark";
  const iconEl = document.getElementById("login-theme-icon");
  const labelEl = document.getElementById("login-theme-label");

  if (iconEl) {
    iconEl.textContent = isDark ? "☀" : "☾";
  }
  if (labelEl) {
    labelEl.textContent = tLogin(isDark ? "login.theme_light" : "login.theme_dark");
  }
}

// Aplica o tema claro/escuro na tela de login e propaga para o painel borrado ao fundo
function aplicarTemaLogin(tema, notificar = false) {
  const temaNormalizado = tema === "dark" ? "dark" : "light";
  const isDark = temaNormalizado === "dark";

  document.body.classList.toggle("tema--escuro", isDark);
  try {
    localStorage.setItem(STORAGE_KEY_TEMA, temaNormalizado);
  } catch (e) {
    // Ignora erros de acesso ao armazenamento local
  }

  atualizarBotaoTemaUI(temaNormalizado);
  sincronizarClasseTemaIframe(isDark);
  sincronizarPainelFundo({ tipo: "cco-sync-tema", tema: temaNormalizado });

  if (notificar) {
    notifyLogin(tLogin(isDark ? "login.toast_theme_dark" : "login.toast_theme_light"));
  }
}

// Aplica o idioma selecionado nos textos do card e propaga para o painel de fundo
function aplicarIdiomaLogin(lang) {
  idiomaLogin = lang === "en-US" ? "en-US" : "pt-BR";
  try {
    localStorage.setItem(STORAGE_KEY_IDIOMA, idiomaLogin);
  } catch (e) {
    // Ignora erros de acesso ao armazenamento local
  }

  document.documentElement.lang = idiomaLogin;
  document.title = tLogin("login.page_title");

  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = tLogin(key);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.setAttribute("placeholder", tLogin(key));
  });

  document.querySelectorAll("[data-i18n-aria]").forEach(el => {
    const key = el.getAttribute("data-i18n-aria");
    if (key) el.setAttribute("aria-label", tLogin(key));
  });

  const langSelect = document.getElementById("login-language-select");
  if (langSelect) {
    langSelect.value = idiomaLogin;
  }

  atualizarBotaoTemaUI(obterTemaAtual());
  sincronizarPainelFundo({ tipo: "cco-sync-idioma", idioma: idiomaLogin });
}

// Gera as iniciais do operador para exibir no avatar do cabeçalho após o login
function extrairIniciaisOperador(nome) {
  const limpo = String(nome || "")
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .trim();

  if (!limpo) return "CCO";
  const partes = limpo.split(/\s+/).filter(Boolean);
  if (partes.length === 1) {
    return partes[0].slice(0, 3).toUpperCase();
  }
  return (partes[0][0] + partes[1][0]).toUpperCase();
}

// Exibe mensagem de erro inline e destaca o campo inválido
function exibirErroFormulario(mensagem, campoGrupoId) {
  const erroEl = document.getElementById("login-error");
  document.querySelectorAll(".login-campo--invalido").forEach(el => {
    el.classList.remove("login-campo--invalido");
  });

  if (campoGrupoId) {
    const grupo = document.getElementById(campoGrupoId);
    if (grupo) grupo.classList.add("login-campo--invalido");
  }

  if (erroEl) {
    erroEl.textContent = mensagem;
    erroEl.hidden = false;
  }
}

// Limpa o estado de erro ao editar qualquer campo do formulário
function limparErroFormulario() {
  const erroEl = document.getElementById("login-error");
  if (erroEl) {
    erroEl.textContent = "";
    erroEl.hidden = true;
  }
  document.querySelectorAll(".login-campo--invalido").forEach(el => {
    el.classList.remove("login-campo--invalido");
  });
}

// Inicialização dos eventos da tela de login após o carregamento do DOM
document.addEventListener("DOMContentLoaded", () => {
  aplicarTemaLogin(obterTemaAtual(), false);
  aplicarIdiomaLogin(obterIdiomaAtual());

  const backdropFrameEl = document.getElementById("login-backdrop-frame");
  const overlayEl = document.getElementById("login-overlay");
  const themeToggleBtn = document.getElementById("login-theme-toggle");
  const langSelectEl = document.getElementById("login-language-select");
  const formEl = document.getElementById("login-form");
  const userInput = document.getElementById("login-usuario");
  const passInput = document.getElementById("login-password");
  const unitSelect = document.getElementById("login-unidade");
  const rememberCheckbox = document.getElementById("login-remember");
  const togglePassBtn = document.getElementById("toggle-password");
  const submitBtn = document.getElementById("login-submit");
  const fillDemoBtn = document.getElementById("btn-fill-demo");
  const forgotBtn = document.getElementById("btn-forgot-password");
  const forgotModal = document.getElementById("forgot-password-modal");
  const forgotCloseBtn = document.getElementById("forgot-modal-close");

  // Garante que o painel de fundo receba tema e idioma atuais assim que terminar de carregar
  if (backdropFrameEl) {
    backdropFrameEl.addEventListener("load", () => {
      const temaAtual = obterTemaAtual();
      sincronizarClasseTemaIframe(temaAtual === "dark");
      sincronizarPainelFundo({ tipo: "cco-sync-tema", tema: temaAtual });
      sincronizarPainelFundo({ tipo: "cco-sync-idioma", idioma: idiomaLogin });
    });
  }

  // Alterna entre tema claro e escuro dentro do card e no painel de fundo
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const proximoTema = obterTemaAtual() === "dark" ? "light" : "dark";
      aplicarTemaLogin(proximoTema, true);
    });
  }

  // Atualiza o idioma da interface dentro do card e no painel de fundo
  if (langSelectEl) {
    langSelectEl.addEventListener("change", event => {
      aplicarIdiomaLogin(event.target.value);
    });
  }

  // Alterna visibilidade da senha digitada
  if (togglePassBtn && passInput) {
    togglePassBtn.addEventListener("click", () => {
      const mostrando = passInput.type === "text";
      passInput.type = mostrando ? "password" : "text";
      togglePassBtn.setAttribute("aria-pressed", String(!mostrando));
      togglePassBtn.setAttribute(
        "aria-label",
        tLogin(mostrando ? "login.show_password" : "login.hide_password")
      );
      togglePassBtn.textContent = mostrando ? "👁" : "🙈";
    });
  }

  if (userInput) {
    userInput.addEventListener("input", limparErroFormulario);
  }
  if (passInput) {
    passInput.addEventListener("input", limparErroFormulario);
  }

  // Preenche rapidamente credenciais demonstrativas do CCO
  if (fillDemoBtn && userInput && passInput) {
    fillDemoBtn.addEventListener("click", () => {
      limparErroFormulario();
      userInput.value = "operador.cco@emap.ma.gov.br";
      passInput.value = "copi2026";
      if (unitSelect) unitSelect.value = "all";
      notifyLogin(tLogin("login.toast_demo_filled"), "sincronizando", 2000);
      userInput.focus();
    });
  }

  // Abre o modal de recuperação de credenciais
  if (forgotBtn && forgotModal) {
    forgotBtn.addEventListener("click", () => {
      if (typeof forgotModal.showModal === "function") {
        if (!forgotModal.open) forgotModal.showModal();
      } else {
        forgotModal.setAttribute("open", "");
      }
    });
  }

  // Fecha o modal de recuperação pelo botão ou clique no backdrop
  if (forgotCloseBtn && forgotModal) {
    forgotCloseBtn.addEventListener("click", () => {
      if (typeof forgotModal.close === "function" && forgotModal.open) {
        forgotModal.close();
      } else {
        forgotModal.removeAttribute("open");
      }
    });
  }

  if (forgotModal) {
    forgotModal.addEventListener("click", event => {
      if (event.target === forgotModal) {
        if (typeof forgotModal.close === "function" && forgotModal.open) {
          forgotModal.close();
        } else {
          forgotModal.removeAttribute("open");
        }
      }
    });
  }

  // Valida o envio do formulário e executa o efeito Esmaecer / Dissolver (Fade / Dissolve)
  if (formEl) {
    formEl.addEventListener("submit", event => {
      event.preventDefault();
      limparErroFormulario();

      const usuario = (userInput?.value || "").trim();
      const senha = passInput?.value || "";
      const unidade = unitSelect?.value || "all";
      const manterConectado = Boolean(rememberCheckbox?.checked);

      if (!usuario) {
        exibirErroFormulario(tLogin("login.err_user_required"), "grupo-usuario");
        userInput?.focus();
        return;
      }

      if (!senha) {
        exibirErroFormulario(tLogin("login.err_pass_required"), "grupo-senha");
        passInput?.focus();
        return;
      }

      if (senha.length < 4) {
        exibirErroFormulario(tLogin("login.err_pass_min"), "grupo-senha");
        passInput?.focus();
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = tLogin("login.submitting");
      }

      const sessao = {
        usuario,
        iniciais: extrairIniciaisOperador(usuario),
        unidade,
        autenticadoEm: new Date().toISOString()
      };

      try {
        const serializado = JSON.stringify(sessao);
        if (manterConectado) {
          localStorage.setItem(STORAGE_KEY_SESSAO, serializado);
          sessionStorage.removeItem(STORAGE_KEY_SESSAO);
        } else {
          sessionStorage.setItem(STORAGE_KEY_SESSAO, serializado);
          localStorage.removeItem(STORAGE_KEY_SESSAO);
        }
        // Sinaliza ao index.html que deve executar a entrada suave em Fade / Dissolve
        sessionStorage.setItem(STORAGE_KEY_FADE_ENTRADA, "1");
      } catch (e) {
        // Ignora erros de acesso ao armazenamento
      }

      notifyLogin(tLogin("login.toast_success"), "sucesso", 2000);

      // Inicia a dissolução do logo, do card e do vidro borrado antes de abrir o painel principal
      if (overlayEl) {
        overlayEl.classList.add("login-overlay--dissolvendo");
      }

      setTimeout(() => {
        window.location.href = "index.html";
      }, 560);
    });
  }
});
