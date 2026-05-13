// Tabbed modal panels + expandable form controls.
//
// Two small behaviors used inside modals, kept together because they share
// the same "find your trigger and your target" pattern.
//
// Tabs:
//   <nav class="modal-tabs" data-tabs="<id>">
//     <button class="modal-tab active" data-tab="password">…</button>
//     <button class="modal-tab" data-tab="totp">…</button>
//   </nav>
//   <div class="modal-tab-content" data-tab-panel="password">…</div>
//   <div class="modal-tab-content" data-tab-panel="totp" hidden>…</div>
//
//   Initial active panel = the one whose .modal-tab has `.active`; siblings
//   are hidden via the `hidden` attribute (which respects the modal's
//   scroll height — better than display:none).
//
// Expandable:
//   <button data-expand="<target-id>">Show form</button>
//   <form id="<target-id>" hidden>…</form>
//
//   Click toggles the hidden attribute. No animation — keeps motion budget
//   for the modals themselves.

export function initModalTabs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.modal-tabs[data-tabs]').forEach((nav) => {
    const tabs = Array.from(nav.querySelectorAll<HTMLButtonElement>('.modal-tab'));
    const scope = nav.closest('.modal') ?? document;
    tabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        if (!target) return;
        tabs.forEach((b) => b.classList.toggle('active', b === btn));
        scope.querySelectorAll<HTMLElement>('[data-tab-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.tabPanel !== target;
        });
      });
    });
  });
}

export function initExpandButtons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-expand]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.expand;
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (!target) return;
      target.hidden = !target.hidden;
      // First input gets focus when revealing.
      if (!target.hidden) {
        target.querySelector<HTMLInputElement>('input, textarea, select')?.focus();
      }
    });
  });
}
