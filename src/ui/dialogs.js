const $ = (id) => document.getElementById(id);

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

// Resolve com `true` só quando a pessoa confirma explicitamente.
export function confirmAction({ title, message, confirmLabel }) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = confirmLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirmar'), { once: true });
  });
}

// Troca o nome na lista por um campo; Enter ou sair do campo confirma, Esc desiste.
function editName(name, project, onRename) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'project-rename';
  input.value = project.name;
  input.maxLength = 60;
  input.spellcheck = false;
  input.setAttribute('aria-label', `Novo nome para “${project.name}”`);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(name);
    if (save && value && value !== project.name) onRename(project, value);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    // Sem isso, Enter enviaria o formulário e Esc fecharia a janela de projetos.
    event.preventDefault();
    finish(event.key === 'Enter');
  });
  input.addEventListener('blur', () => finish(true));
  name.replaceWith(input);
  input.focus();
  input.select();
}

export function createProjectsDialog({ onOpen, onRename, onDelete, onNew, onTapestry }) {
  const dialog = $('projects');
  const list = $('project-list');
  const empty = $('project-empty');
  $('project-new').addEventListener('click', () => onNew());
  $('project-tapestry').addEventListener('click', () => onTapestry());

  function button(label, className, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', action);
    return element;
  }

  return {
    get open() {
      return dialog.open;
    },

    show(projects, currentId) {
      list.replaceChildren(...projects.map((project) => {
        const item = document.createElement('li');
        const current = project.id === currentId;
        item.classList.toggle('is-current', current);
        const info = document.createElement('div');
        info.className = 'project-info';
        const name = document.createElement('strong');
        name.textContent = project.name;
        const date = document.createElement('small');
        date.textContent = `${current ? 'Aberto agora · ' : ''}salvo em ${dateFormat.format(project.updatedAt)}`;
        info.append(name, date);
        item.append(
          info,
          button('Renomear', 'button-secondary', () => editName(name, project, onRename)),
          button('Abrir', 'button-secondary', () => onOpen(project)),
          button('Excluir', 'button-danger', () => onDelete(project)),
        );
        return item;
      }));
      empty.hidden = projects.length > 0;
      if (!dialog.open) dialog.showModal();
    },

    close() {
      dialog.close();
    },
  };
}

// Sem conta não há onde salvar: a janela só fecha depois que a pessoa entra.
export function createAccountDialog(onEnter) {
  const dialog = $('account');
  const form = $('account-form');
  const user = $('account-user');
  const password = $('account-password');
  const error = $('account-error');
  const lead = $('account-lead');
  const defaultLead = lead.textContent;
  let entered = null;

  dialog.addEventListener('cancel', (event) => event.preventDefault());

  async function submit(creating) {
    if (form.getAttribute('aria-busy')) return;
    form.setAttribute('aria-busy', 'true');
    error.hidden = true;
    try {
      await onEnter({ username: user.value.trim(), password: password.value, creating });
      password.value = '';
      dialog.close();
      entered.resolve();
    } catch (failure) {
      error.textContent = `Não foi possível ${creating ? 'criar a conta' : 'entrar'}: ${failure.message}.`;
      error.hidden = false;
    } finally {
      form.removeAttribute('aria-busy');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(false);
  });
  $('account-signup').addEventListener('click', () => {
    if (form.reportValidity()) submit(true);
  });

  return {
    // Resolve quando a pessoa entra; chamar de novo com a janela aberta devolve a mesma espera.
    show(message) {
      if (!dialog.open) {
        entered = Promise.withResolvers();
        lead.textContent = message ?? defaultLead;
        error.hidden = true;
        dialog.showModal();
        user.focus();
      }
      return entered.promise;
    },
  };
}

export function createSettingsDialog(settings, onChange) {
  const dialog = $('settings');
  const follow = $('setting-follow');
  const guide = $('setting-guide');
  const names = $('setting-names');

  const sync = () => {
    follow.value = String(settings.followRate);
    guide.checked = settings.pullGuide;
    names.checked = settings.stitchNames;
  };
  follow.addEventListener('input', () => onChange({ followRate: Number(follow.value) }));
  guide.addEventListener('change', () => onChange({ pullGuide: guide.checked }));
  names.addEventListener('change', () => onChange({ stitchNames: names.checked }));

  return {
    show() {
      sync();
      dialog.showModal();
    },
  };
}

export function createTapestryDialog(onCreate) {
  const dialog = $('tapestry');
  const columns = $('tapestry-columns');
  // Cancelar não envia o formulário: assim Enter no campo aciona "Começar tapeçaria".
  $('tapestry-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'criar') onCreate(columns.value);
  });

  return {
    show() {
      dialog.returnValue = '';
      dialog.showModal();
      columns.select();
    },
  };
}
