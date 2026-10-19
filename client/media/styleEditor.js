// Editor degli stili di formattazione: interfaccia della webview.
// Riceve dall'estensione schema, stili e valori; invia modifiche e richieste di anteprima.
(function () {
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState() || {};

    let sections = [];
    let folder = '';
    let styles = [];
    let activeName = '';
    let selected;
    let sectionId = saved.sectionId || 'lists';
    // SQL di anteprima scritto dall'utente, per sezione
    const customSql = saved.customSql || {};
    const preview = { text: '', engine: '', error: '' };
    let previewTimer;

    const app = document.getElementById('app');

    function persist() {
        vscode.setState({ sectionId, customSql });
    }

    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else if (v === true) node.setAttribute(k, '');
            else node.setAttribute(k, String(v));
        }
        for (const c of children.flat()) {
            if (c === null || c === undefined || c === false) continue;
            node.append(c instanceof Node ? c : document.createTextNode(String(c)));
        }
        return node;
    }

    function button(label, onclick, opts = {}) {
        return el('button', { class: opts.primary ? 'primary' : 'secondary', onclick, disabled: opts.disabled, title: opts.title }, label);
    }

    function currentSection() {
        return sections.find(s => s.id === sectionId) || sections[0];
    }

    function requestPreview(delay = 200) {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            const section = currentSection();
            if (!section || !selected) return;
            vscode.postMessage({ type: 'preview', sectionId: section.id, sql: customSql[section.id] });
        }, delay);
    }

    // ── pezzi dell'interfaccia ───────────────────────────────────────────────

    function toolbar() {
        const select = el('select', {
            id: 'style-select',
            'aria-label': 'Formatting style',
            onchange: e => vscode.postMessage({ type: 'select', filePath: e.target.value }),
        }, styles.map(s => el('option', { value: s.filePath, selected: selected && s.filePath === selected.filePath }, s.name)));
        const isActive = selected && selected.name === activeName;
        return el('header', { class: 'toolbar' },
            el('div', { class: 'toolbar-group' },
                el('label', { for: 'style-select', class: 'toolbar-label' }, 'Style'),
                select,
                isActive ? el('span', { class: 'badge', title: 'This style formats SQL documents' }, 'Active') : null,
            ),
            el('div', { class: 'toolbar-group' },
                button('New…', () => vscode.postMessage({ type: 'new' })),
                button('Duplicate…', () => vscode.postMessage({ type: 'duplicate' }), { disabled: !selected }),
                button('Rename…', () => vscode.postMessage({ type: 'rename' }), { disabled: !selected }),
                button('Delete', () => vscode.postMessage({ type: 'delete' }), { disabled: !selected }),
                button('Open JSON', () => vscode.postMessage({ type: 'openJson' }), { disabled: !selected }),
            ),
            el('div', { class: 'toolbar-group toolbar-end' },
                selected && selected.dirty ? el('span', { class: 'dirty' }, 'Unsaved changes') : null,
                button('Use for formatting', () => vscode.postMessage({ type: 'activate' }), { disabled: !selected || isActive }),
                button('Revert', () => vscode.postMessage({ type: 'revert' }), { disabled: !selected || !selected.dirty }),
                button('Save', () => vscode.postMessage({ type: 'save' }), { primary: true, disabled: !selected || !selected.dirty }),
            ),
        );
    }

    function nav() {
        return el('nav', { class: 'sections', 'aria-label': 'Option sections' },
            sections.map(s => {
                const changed = selected && s.groups.some(g => g.options.some(o => selected.customized.includes(o.key)));
                return el('button', {
                    class: 'section' + (s.id === sectionId ? ' current' : ''),
                    'aria-current': s.id === sectionId ? 'page' : undefined,
                    onclick: () => { sectionId = s.id; persist(); render(); requestPreview(0); },
                }, s.title, changed ? el('span', { class: 'mark', title: 'Contains options different from the default' }, '●') : null);
            }));
    }

    function control(option) {
        const value = selected.values[option.key];
        const enabled = !option.enabledWhen || selected.values[option.enabledWhen] === true;
        const id = 'opt-' + option.key.replace(/\./g, '-');
        const send = v => { vscode.postMessage({ type: 'change', key: option.key, value: v }); };
        let input;
        if (option.type === 'bool') {
            input = el('input', { type: 'checkbox', id, checked: value === true, disabled: !enabled, onchange: e => send(e.target.checked) });
        } else if (option.type === 'int') {
            input = el('input', {
                type: 'number', id, value, min: option.min, max: option.max, step: 1, disabled: !enabled,
                onchange: e => send(Number(e.target.value)),
            });
        } else {
            input = el('select', { id, disabled: !enabled, onchange: e => send(e.target.value) },
                option.choices.map(c => el('option', { value: c.value, selected: c.value === value }, c.label)));
        }
        const changed = selected.customized.includes(option.key);
        return el('div', { class: 'option ' + option.type + (enabled ? '' : ' disabled') + (changed ? ' changed' : '') },
            option.type === 'bool' ? input : null,
            el('label', { for: id }, option.label),
            option.type === 'bool' ? null : input,
            changed
                ? el('button', {
                    class: 'reset', title: 'Reset to the SQL Prompt default', 'aria-label': 'Reset ' + option.label + ' to default',
                    onclick: () => vscode.postMessage({ type: 'reset', key: option.key }),
                }, '↺')
                : el('span', { class: 'reset-placeholder' }),
        );
    }

    function options() {
        const section = currentSection();
        return el('section', { class: 'options', 'aria-label': section.title + ' options' },
            el('h2', {}, section.title),
            section.groups.map(g => el('fieldset', {},
                el('legend', {}, g.title),
                g.options.map(control),
            )));
    }

    function previewPane() {
        const section = currentSection();
        const usingCustom = customSql[section.id] !== undefined;
        return el('section', { class: 'preview', 'aria-label': 'Preview' },
            el('div', { class: 'preview-header' },
                el('h2', {}, 'Preview'),
                el('span', { class: 'engine', id: 'preview-engine', title: 'Engine that produced the preview' }, engineLabel()),
            ),
            el('p', { class: 'error', id: 'preview-error', role: 'status', hidden: !preview.error }, preview.error),
            el('pre', { class: 'sql', id: 'preview-sql', tabindex: 0, 'aria-label': 'Formatted SQL' }, preview.text || ' '),
            el('details', { class: 'sample', open: usingCustom },
                el('summary', {}, 'Sample SQL'),
                el('textarea', {
                    spellcheck: 'false', rows: 8, 'aria-label': 'Sample SQL for the preview',
                    oninput: e => {
                        const first = customSql[section.id] === undefined;
                        customSql[section.id] = e.target.value;
                        persist();
                        // alla prima modifica compare il pulsante per tornare all'esempio
                        if (first) render();
                        requestPreview(400);
                    },
                }, customSql[section.id] !== undefined ? customSql[section.id] : section.preview),
                usingCustom ? button('Restore the sample', () => { delete customSql[section.id]; persist(); render(); requestPreview(0); }) : null,
            ),
        );
    }

    function engineLabel() {
        if (!preview.engine) return '';
        return preview.engine === 'dotnet' ? '.NET engine' : 'built-in formatter';
    }

    function emptyState() {
        if (!folder) {
            return el('div', { class: 'empty' },
                el('h1', {}, 'SQL formatting styles'),
                el('p', {}, 'Choose the folder that contains your SQL Prompt style files (.json). New styles are saved there too.'),
                button('Choose folder…', () => vscode.postMessage({ type: 'chooseFolder' }), { primary: true }));
        }
        return el('div', { class: 'empty' },
            el('h1', {}, 'No styles yet'),
            el('p', {}, 'The folder ' + folder + ' contains no style files.'),
            el('div', { class: 'toolbar-group' },
                button('New style…', () => vscode.postMessage({ type: 'new' }), { primary: true }),
                button('Choose another folder…', () => vscode.postMessage({ type: 'chooseFolder' }))));
    }

    function render() {
        // conserva il fuoco sul controllo che l'utente sta usando
        const focusedId = document.activeElement && document.activeElement.id;
        const textarea = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
        const caret = textarea ? document.activeElement.selectionStart : null;
        app.replaceChildren();
        if (!sections.length) { app.append(el('p', { class: 'loading' }, 'Loading styles…')); return; }
        if (!selected) { app.append(emptyState()); return; }
        app.append(toolbar(), el('main', { class: 'layout' }, nav(), options(), previewPane()));
        if (focusedId) {
            const again = document.getElementById(focusedId);
            if (again) again.focus();
        } else if (textarea) {
            const t = app.querySelector('textarea');
            if (t) { t.focus(); t.selectionStart = t.selectionEnd = caret; }
        }
    }

    window.addEventListener('message', e => {
        const m = e.data;
        if (m.type === 'init') {
            sections = m.sections;
            folder = m.folder;
            if (!sections.some(s => s.id === sectionId)) sectionId = sections[0].id;
        } else if (m.type === 'state') {
            const changedStyle = !selected || !m.selected || selected.filePath !== m.selected.filePath;
            styles = m.styles;
            activeName = m.activeName;
            selected = m.selected;
            render();
            requestPreview(changedStyle ? 0 : 150);
            return;
        } else if (m.type === 'preview') {
            if (m.sectionId !== sectionId) return;
            preview.text = m.text;
            preview.engine = m.engine;
            preview.error = m.error || '';
            // aggiorna solo l'anteprima, senza ridisegnare la pagina (il fuoco resta dov'è)
            const pre = document.getElementById('preview-sql');
            if (pre) {
                pre.textContent = preview.text || ' ';
                document.getElementById('preview-engine').textContent = engineLabel();
                const err = document.getElementById('preview-error');
                err.textContent = preview.error;
                err.hidden = !preview.error;
                return;
            }
        }
        render();
    });

    vscode.postMessage({ type: 'ready' });
})();
