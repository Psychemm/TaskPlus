'use strict';

// The per-list options menu, modeled on Calendar's own calendar-options menu:
// a couple of actions, a divider, then the 24-color palette grid with a
// custom-color button.

TLC.menu = (() => {
  let el = null;
  let anchor = null;
  let listId = null;
  let picker = null;

  function close({ focusAnchor = false } = {}) {
    if (!el) return;
    TLC.tooltip.hide();
    el.remove();
    el = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onDismiss);
    window.removeEventListener('blur', onDismiss);
    document.removeEventListener('scroll', onScroll, true);
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      // Focus first: the button is only displayed while its row is hovered,
      // focused, or has its menu open.
      if (focusAnchor && anchor.isConnected) anchor.focus();
      anchor.closest('.tlc-row')?.classList.remove('tlc-row--menu-open');
    }
    anchor = null;
    listId = null;
  }

  const onDismiss = () => close();
  const onScroll = (e) => {
    if (el && !el.contains(e.target)) close();
  };
  function onOutside(e) {
    if (el && !el.contains(e.target) && !anchor?.contains(e.target)) close();
  }

  function focusables() {
    return el ? [...el.querySelectorAll('[role^="menuitem"]')] : [];
  }

  function onKey(e) {
    if (!el) return;
    const items = focusables();
    const i = items.indexOf(document.activeElement);
    const swatch = document.activeElement?.classList.contains('tlc-swatch');
    let next = null;
    switch (e.key) {
      case 'Escape':
        close({ focusAnchor: true });
        break;
      case 'Tab':
        close();
        return;
      case 'ArrowDown':
        next = swatch ? i + 6 : i + 1;
        break;
      case 'ArrowUp':
        next = swatch ? i - 6 : i - 1;
        break;
      case 'ArrowRight':
        if (swatch) next = i + 1;
        break;
      case 'ArrowLeft':
        if (swatch) next = i - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Enter':
      case ' ':
        if (i >= 0) items[i].click();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (next !== null && items.length) items[Math.max(0, Math.min(items.length - 1, next))].focus();
  }

  function item(label, onSelect) {
    return TLC.h(
      'div',
      {
        class: 'tlc-menu__item',
        role: 'menuitem',
        tabindex: '-1',
        onclick: () => {
          close({ focusAnchor: true });
          onSelect();
        },
      },
      TLC.h('span', { class: 'tlc-menu__label' }, label)
    );
  }

  function swatch(name, hex, selected, onSelect, extraClass = '') {
    const s = TLC.h(
      'div',
      {
        class: `tlc-swatch ${extraClass}`.trim(),
        role: 'menuitemradio',
        tabindex: '-1',
        'aria-checked': String(selected),
        'aria-label': `${name}, set list color`,
        style: hex ? { backgroundColor: hex } : null,
        onclick: onSelect,
      },
      hex ? TLC.icon('check', 14) : TLC.icon('add', 16)
    );
    TLC.tooltip.attach(s, name, { delay: 300 });
    return s;
  }

  // Opens the browser's color picker next to the list's options button.
  // Dragging previews live; the color is saved once the picker closes.
  function pickCustom(id, current, rect) {
    if (!picker) {
      picker = TLC.h('input', { type: 'color', class: 'tlc-color-input', tabindex: '-1', 'aria-hidden': 'true' });
      document.body.append(picker);
    }
    picker.style.left = `${rect.left}px`;
    picker.style.top = `${rect.bottom}px`;
    picker.value = (current || '#4285F4').toLowerCase();
    picker.oninput = () => TLC.store.previewColor(id, picker.value);
    picker.onchange = () => TLC.store.setColor(id, picker.value);
    try {
      picker.showPicker();
    } catch {
      picker.click();
    }
  }

  function build(id, title) {
    const current = TLC.store.colorOf(id)?.toUpperCase();
    const inPalette = TLC.PALETTE.some(([, hex]) => hex === current);
    const choose = (hex) => () => {
      close({ focusAnchor: true });
      TLC.store.setColor(id, hex);
    };

    const rows = [];
    for (let r = 0; r < 4; r++) {
      rows.push(
        TLC.h(
          'div',
          { class: 'tlc-swatch-row' },
          TLC.PALETTE.slice(r * 6, r * 6 + 6).map(([name, hex]) => swatch(name, hex, hex === current, choose(hex)))
        )
      );
    }
    rows.push(
      TLC.h(
        'div',
        { class: 'tlc-swatch-row' },
        current && !inPalette ? swatch('List color', current, true, choose(current)) : null,
        swatch(
          'Add custom color',
          null,
          false,
          () => {
            const rect = anchor.getBoundingClientRect();
            close({ focusAnchor: true });
            pickCustom(id, current, rect);
          },
          'tlc-swatch--add'
        )
      )
    );

    const anyOtherHidden = TLC.store.lists().some((l) => l.id !== id && TLC.store.isHidden(l.id));
    return TLC.h(
      'div',
      { class: 'tlc-menu', role: 'menu', 'aria-label': `Options for ${title}` },
      TLC.h(
        'div',
        { class: 'tlc-menu__list' },
        item('Display this only', () => TLC.store.showOnly(id)),
        anyOtherHidden || TLC.store.isHidden(id) ? item('Show all task lists', () => TLC.store.showAll()) : null
      ),
      TLC.h('div', { class: 'tlc-menu__divider', role: 'separator' }),
      TLC.h('div', { class: 'tlc-swatches', role: 'group', 'aria-label': 'List color' }, rows)
    );
  }

  function position(menu, btn) {
    const r = btn.getBoundingClientRect();
    const m = { width: menu.offsetWidth, height: menu.offsetHeight }; // unaffected by the open animation's scale
    let left = r.left;
    let top = r.bottom;
    if (left + m.width > innerWidth - 8) left = Math.max(8, r.right - m.width);
    if (top + m.height > innerHeight - 8) top = Math.max(8, r.top - m.height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.transformOrigin = `${left === r.left ? 'left' : 'right'} ${top === r.bottom ? 'top' : 'bottom'}`;
  }

  function open(btn, id, title) {
    if (el && anchor === btn) {
      close();
      return;
    }
    close();
    anchor = btn;
    listId = id;
    el = build(id, title);
    // Keep Calendar's own handlers (shortcuts, jsaction) out of our menu.
    for (const type of ['click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'keypress']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
    // Pin the row's hover state first so the button stays displayed and measurable.
    btn.setAttribute('aria-expanded', 'true');
    btn.closest('.tlc-row')?.classList.add('tlc-row--menu-open');
    document.body.append(el);
    position(el, btn);
    requestAnimationFrame(() => el?.classList.add('tlc-menu--open'));
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('blur', onDismiss);
    focusables()[0]?.focus();
  }

  return {
    open,
    close,
    get openFor() {
      return el ? listId : null;
    },
  };
})();
