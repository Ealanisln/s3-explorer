// In-app confirm / prompt / alert dialogs that replace the browser-native
// `confirm()`, `prompt()`, and `alert()` calls. The native ones render as
// "s3explorer.localhost dice ..." chrome which looks unprofessional and
// breaks the visual language of the app.
//
// Each function returns a Promise. The DOM root is created on first use and
// reused for subsequent calls. Multiple concurrent calls stack — the most
// recent one is on top because z-index is incremented per call.
//
// Keyboard:
//   - Esc           → cancel (resolve false / null)
//   - Enter         → confirm (resolve true / value)  unless inside textarea
//   - Tab           → cycles inside the modal (lightweight trap)

import { escapeHtml } from './dom.js';
import { t } from '../i18n/index.js';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;  // confirm button uses .btn-danger-solid
  /** Render `message` as HTML instead of escaping it. Use only with trusted strings. */
  html?: boolean;
}

export interface PromptOptions {
  title?: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  inputType?: 'text' | 'password' | 'number';
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;  // return error message or null
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
  recommended?: boolean;
}

export interface ChoiceOptions<V extends string> {
  title?: string;
  message: string;
  choices: ChoiceOption<V>[];
  cancelLabel?: string;
}

let zCounter = 1000;

function buildBackdrop(): HTMLDivElement {
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop dialog-backdrop';
  bd.style.zIndex = String(++zCounter);
  return bd;
}

/** True until the dialog is dismissed (resolved). */
function focusFirst(root: HTMLElement): void {
  const target = root.querySelector<HTMLElement>('[data-autofocus]')
    || root.querySelector<HTMLElement>('input, textarea, button.btn-primary, button.btn-danger-solid, button');
  target?.focus();
}

function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== 'Tab') return;
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const bd = buildBackdrop();
    const messageHtml = opts.html ? opts.message : escapeHtml(opts.message).replace(/\n/g, '<br>');
    bd.innerHTML = `
      <div class="modal modal-sm dialog-modal">
        ${opts.title ? `<header><h3>${escapeHtml(opts.title)}</h3></header>` : ''}
        <div class="modal-body dialog-body">
          <p class="dialog-msg">${messageHtml}</p>
        </div>
        <footer class="dialog-foot">
          <button type="button" class="btn" data-act="cancel">${escapeHtml(opts.cancelLabel || t('common.cancel'))}</button>
          <button type="button" class="btn ${opts.danger ? 'btn-danger-solid' : 'btn-primary'}" data-act="confirm" data-autofocus>${escapeHtml(opts.confirmLabel || t('common.accept'))}</button>
        </footer>
      </div>
    `;
    document.body.appendChild(bd);

    const done = (result: boolean): void => {
      document.removeEventListener('keydown', onKey);
      bd.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') {
        const t = e.target as HTMLElement | null;
        if (t && t.tagName === 'TEXTAREA') return;
        e.preventDefault(); done(true);
      } else trapTab(e, bd);
    };

    bd.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target === bd) { done(false); return; }
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'confirm') done(true);
      else if (act === 'cancel') done(false);
    });
    document.addEventListener('keydown', onKey);
    focusFirst(bd);
  });
}

export function alertDialog(message: string, title?: string): Promise<void> {
  return confirmDialog({
    title,
    message,
    confirmLabel: 'OK',
    cancelLabel: '',
  }).then(() => undefined);
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const bd = buildBackdrop();
    const inputType = opts.inputType || 'text';
    bd.innerHTML = `
      <div class="modal modal-sm dialog-modal">
        ${opts.title ? `<header><h3>${escapeHtml(opts.title)}</h3></header>` : ''}
        <form class="dialog-body" data-form>
          <p class="dialog-msg">${escapeHtml(opts.message).replace(/\n/g, '<br>')}</p>
          <input
            type="${inputType}"
            class="dialog-input"
            name="value"
            value="${escapeHtml(opts.defaultValue || '')}"
            placeholder="${escapeHtml(opts.placeholder || '')}"
            autocomplete="off"
            data-autofocus
          />
          <p class="dialog-error" data-error style="display:none"></p>
        </form>
        <footer class="dialog-foot">
          <button type="button" class="btn" data-act="cancel">${escapeHtml(opts.cancelLabel || t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-act="confirm">${escapeHtml(opts.confirmLabel || t('common.accept'))}</button>
        </footer>
      </div>
    `;
    document.body.appendChild(bd);

    const input = bd.querySelector<HTMLInputElement>('input.dialog-input')!;
    const errEl = bd.querySelector<HTMLElement>('[data-error]')!;

    const done = (result: string | null): void => {
      document.removeEventListener('keydown', onKey);
      bd.remove();
      resolve(result);
    };

    const tryConfirm = (): void => {
      const value = input.value;
      if (opts.validate) {
        const msg = opts.validate(value);
        if (msg) {
          errEl.textContent = msg;
          errEl.style.display = 'block';
          input.focus();
          return;
        }
      }
      done(value);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter') {
        const t = e.target as HTMLElement | null;
        if (t && t.tagName === 'TEXTAREA') return;
        e.preventDefault();
        tryConfirm();
      } else trapTab(e, bd);
    };

    bd.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target === bd) { done(null); return; }
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'confirm') tryConfirm();
      else if (act === 'cancel') done(null);
    });
    document.addEventListener('keydown', onKey);
    focusFirst(bd);
    input.select();
  });
}

export function choiceDialog<V extends string>(opts: ChoiceOptions<V>): Promise<V | null> {
  return new Promise<V | null>((resolve) => {
    const bd = buildBackdrop();
    bd.innerHTML = `
      <div class="modal modal-sm dialog-modal">
        ${opts.title ? `<header><h3>${escapeHtml(opts.title)}</h3></header>` : ''}
        <div class="modal-body dialog-body">
          <p class="dialog-msg">${escapeHtml(opts.message)}</p>
          <div class="dialog-choices">
            ${opts.choices.map((c, i) => `
              <button
                type="button"
                class="dialog-choice${c.recommended ? ' recommended' : ''}"
                data-act="choose"
                data-value="${escapeHtml(c.value)}"
                ${i === 0 ? 'data-autofocus' : ''}
              >
                <span class="dialog-choice-label">${escapeHtml(c.label)}${c.recommended ? `<span class="recommended-tag">${escapeHtml(t('common.recommended'))}</span>` : ''}</span>
                ${c.hint ? `<span class="dialog-choice-hint">${escapeHtml(c.hint)}</span>` : ''}
              </button>
            `).join('')}
          </div>
        </div>
        <footer class="dialog-foot">
          <button type="button" class="btn" data-act="cancel">${escapeHtml(opts.cancelLabel || t('common.cancel'))}</button>
        </footer>
      </div>
    `;
    document.body.appendChild(bd);

    const done = (result: V | null): void => {
      document.removeEventListener('keydown', onKey);
      bd.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else trapTab(e, bd);
    };
    bd.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target === bd) { done(null); return; }
      const btn = target.closest<HTMLElement>('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'cancel') done(null);
      else if (btn.dataset.act === 'choose') done(btn.dataset.value as V);
    });
    document.addEventListener('keydown', onKey);
    focusFirst(bd);
  });
}
