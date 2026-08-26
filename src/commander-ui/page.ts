/** A dependency-free workbench. Every form field is created from /api/schema. */
export const COMMANDER_UI_PAGE = String.raw`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ct Commander Workbench</title>
  <style>
    :root { color-scheme: light; font: 15px/1.45 system-ui, sans-serif; color: #17251f; background: #f3f5ef; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; grid-template-columns: 270px 1fr; }
    nav { padding: 28px 20px; color: #f7fff5; background: #123f33; }
    nav h1 { margin: 0 0 6px; font-size: 22px; }
    nav p { margin: 0 0 24px; color: #bdd3ca; font-size: 13px; }
    nav button { width: 100%; margin: 4px 0; padding: 11px 12px; border: 0; border-radius: 8px; color: inherit; background: transparent; text-align: left; cursor: pointer; }
    nav button:hover, nav button.active { background: #286451; }
    main { max-width: 1050px; width: 100%; padding: 34px clamp(24px, 5vw, 70px); }
    .eyebrow { color: #66766e; font-size: 11px; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; }
    h2 { margin: 5px 0 6px; font-size: 30px; }
    .description { color: #59675f; margin: 0 0 24px; }
    .card { margin: 18px 0; padding: 24px; border: 1px solid #dce2db; border-radius: 14px; background: white; box-shadow: 0 8px 28px #183f2d0a; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
    label { display: block; font-weight: 650; }
    label small { display: block; min-height: 38px; margin: 4px 0 7px; color: #718078; font-weight: 400; }
    input[type=text], textarea, select { width: 100%; padding: 10px 11px; border: 1px solid #bdc8c1; border-radius: 7px; background: #fbfcfa; font: inherit; }
    textarea { min-height: 80px; resize: vertical; }
    .toggle { display: flex; align-items: start; gap: 9px; padding: 8px 0; }
    .toggle input { margin-top: 4px; }
    .optional-value { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: center; }
    code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .preview { padding: 13px; overflow-wrap: anywhere; border-radius: 8px; color: #e7f4ee; background: #173f34; }
    .risk { margin: 16px 0; padding: 12px; border-radius: 8px; color: #793d21; background: #fff0e6; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
    .run { padding: 11px 18px; border: 0; border-radius: 8px; color: white; background: #14634c; font-weight: 750; cursor: pointer; }
    .run:disabled { opacity: .55; cursor: wait; }
    .status { color: #65736c; }
    pre { max-height: 360px; padding: 15px; overflow: auto; white-space: pre-wrap; border-radius: 8px; background: #f1f4f0; }
    .error { color: #8d3028; }
    .outputs { color: #315b4d; }
    @media (max-width: 720px) { body { grid-template-columns: 1fr; } nav { padding: 18px; } main { padding: 24px 18px; } }
  </style>
</head>
<body>
  <nav><h1>ct Workbench</h1><p>Aus Commander erzeugt</p><div id="commands"></div></nav>
  <main>
    <div class="eyebrow">Experimentelle Projektion</div>
    <h2 id="title">Befehle werden geladen …</h2>
    <p class="description" id="description"></p>
    <form id="form" hidden>
      <section class="card"><div class="grid" id="fields"></div></section>
      <section class="card">
        <div class="eyebrow">Tatsächlicher Aufruf</div>
        <p class="preview"><code id="preview"></code></p>
        <div id="confirmation"></div>
        <div class="actions"><button class="run" id="run" type="submit">Ausführen</button><span class="status" id="status"></span></div>
      </section>
    </form>
    <section class="card" id="result" hidden>
      <div class="eyebrow">Ergebnis</div>
      <h3 id="result-title"></h3>
      <div class="outputs" id="outputs"></div>
      <h4>Standardausgabe</h4><pre id="stdout"></pre>
      <h4>Fehlerausgabe</h4><pre id="stderr"></pre>
    </section>
  </main>
<script>
const state = { schema: null, command: null, completionTimer: null };
const byId = (id) => document.getElementById(id);
const quote = (word) => /^[A-Za-z0-9_./:@=-]+$/.test(word) ? word : JSON.stringify(word);

async function api(path, init) {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init && init.headers) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
  return body;
}

function fieldId(kind, name) { return kind + '-' + name.replace(/[^a-z0-9]/gi, '-'); }
function inputFor(kind, item) {
  const wrap = document.createElement('label');
  wrap.dataset.kind = kind;
  wrap.dataset.name = item.name || item.key;
  wrap.dataset.valueKind = item.valueKind || 'argument';
  wrap.dataset.variadic = item.variadic ? 'true' : 'false';
  const title = document.createElement('span');
  title.textContent = kind === 'option' ? item.flags : '<' + item.name + (item.variadic ? '...' : '') + '>';
  wrap.append(title);
  const help = document.createElement('small');
  help.textContent = item.description || '';
  wrap.append(help);

  if (kind === 'option' && item.valueKind === 'boolean') {
    wrap.className = 'toggle';
    const input = document.createElement('input'); input.type = 'checkbox'; input.id = fieldId(kind, item.key);
    wrap.prepend(input);
    return wrap;
  }
  const optional = kind === 'option' && item.valueKind === 'optional';
  const holder = document.createElement('div');
  if (optional) holder.className = 'optional-value';
  if (optional) { const enable = document.createElement('input'); enable.type = 'checkbox'; enable.className = 'enable'; enable.title = 'Option ohne Wert verwenden'; holder.append(enable); }
  let input;
  if (item.choices && item.choices.length) {
    input = document.createElement('select');
    input.append(new Option('— nicht gesetzt —', ''));
    item.choices.forEach((choice) => input.append(new Option(choice, choice)));
  } else if (item.variadic) {
    input = document.createElement('textarea'); input.placeholder = 'Ein Wert pro Zeile';
  } else {
    input = document.createElement('input'); input.type = 'text';
    const list = document.createElement('datalist'); list.id = fieldId(kind, item.name || item.key) + '-choices';
    input.setAttribute('list', list.id); holder.append(list);
    input.addEventListener('input', () => scheduleCompletion(wrap, input, list));
    input.addEventListener('focus', () => scheduleCompletion(wrap, input, list));
  }
  input.className = 'value'; input.id = fieldId(kind, item.name || item.key);
  if (item.defaultValue !== undefined) input.value = String(item.defaultValue);
  if (kind === 'option' && item.key === 'env' && state.schema.defaults.environment) input.value = state.schema.defaults.environment;
  holder.prepend(input);
  wrap.append(holder);
  return wrap;
}

function values() {
  const args = {}, options = {};
  document.querySelectorAll('#fields label').forEach((wrap) => {
    const target = wrap.dataset.kind === 'argument' ? args : options;
    const input = wrap.querySelector('.value, input[type=checkbox]:not(.enable)');
    if (!input) return;
    if (wrap.dataset.valueKind === 'boolean') { if (input.checked) target[wrap.dataset.name] = true; return; }
    const enabled = wrap.querySelector('.enable');
    if (enabled && enabled.checked && !input.value) { target[wrap.dataset.name] = true; return; }
    if (!input.value) return;
    target[wrap.dataset.name] = wrap.dataset.variadic === 'true' ? input.value.split(/\n/).map((v) => v.trim()).filter(Boolean) : input.value;
  });
  return { arguments: args, options };
}

function localArgv() {
  const data = values(), argv = [...state.command.path];
  state.command.arguments.forEach((item) => { const value = data.arguments[item.name]; if (Array.isArray(value)) argv.push(...value); else if (value) argv.push(value); });
  state.command.options.forEach((item) => { const value = data.options[item.key]; if (value === true) argv.push(item.long); else if (value) argv.push(item.long, value); });
  return argv;
}

function updatePreview() { if (state.command) byId('preview').textContent = ['ct', ...localArgv()].map(quote).join(' '); }
async function scheduleCompletion(wrap, input, list) {
  clearTimeout(state.completionTimer);
  state.completionTimer = setTimeout(async () => {
    try {
      const data = values();
      const result = await api('/api/completions', { method: 'POST', body: JSON.stringify({ command: state.command.path, arguments: data.arguments, options: data.options, field: { kind: wrap.dataset.kind, name: wrap.dataset.name }, partial: input.value }) });
      list.replaceChildren(...result.candidates.map((value) => new Option(value)));
    } catch { list.replaceChildren(); }
  }, 120);
}

function selectCommand(command) {
  state.command = command;
  document.querySelectorAll('nav button').forEach((button) => button.classList.toggle('active', button.dataset.path === command.path.join(' ')));
  byId('title').textContent = command.title;
  byId('description').textContent = command.description;
  byId('fields').replaceChildren(...command.arguments.map((item) => inputFor('argument', item)), ...command.options.map((item) => inputFor('option', item)));
  byId('confirmation').innerHTML = command.risk === 'state-write' ? '<div class="risk"><label class="toggle"><input id="confirmed" type="checkbox"> Ich bestätige die lokale Änderung der State-Datei.</label></div>' : '';
  byId('form').hidden = false; byId('result').hidden = true;
  byId('fields').addEventListener('input', updatePreview); byId('fields').addEventListener('change', updatePreview);
  updatePreview();
}

async function boot() {
  const secret = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
  if (secret) { await api('/api/session/bootstrap', { method: 'POST', body: JSON.stringify({ secret }) }); history.replaceState(null, '', location.pathname); }
  state.schema = await api('/api/schema');
  state.schema.commands.forEach((command) => { const button = document.createElement('button'); button.type = 'button'; button.dataset.path = command.path.join(' '); button.textContent = command.title; button.onclick = () => selectCommand(command); byId('commands').append(button); });
  if (state.schema.commands[0]) selectCommand(state.schema.commands[0]);
}

byId('form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = byId('run'); button.disabled = true; byId('status').textContent = 'Läuft …'; byId('result').hidden = true;
  try {
    const data = values();
    const result = await api('/api/runs', { method: 'POST', body: JSON.stringify({ command: state.command.path, arguments: data.arguments, options: data.options, confirmed: !byId('confirmed') || byId('confirmed').checked }) });
    byId('result').hidden = false; byId('result-title').textContent = result.exitCode === 0 ? 'Erfolgreich beendet' : 'Beendet mit Exitcode ' + result.exitCode;
    byId('result-title').className = result.exitCode === 0 ? '' : 'error';
    byId('stdout').textContent = result.stdout || '—'; byId('stderr').textContent = result.stderr || '—';
    byId('outputs').textContent = result.reportOutputs.length ? 'Ausgabepfade: ' + result.reportOutputs.join(', ') : '';
    byId('status').textContent = result.truncated ? 'Ausgabe wurde begrenzt.' : '';
  } catch (error) { byId('status').textContent = error.message; byId('status').className = 'status error'; }
  finally { button.disabled = false; }
});
boot().catch((error) => { byId('title').textContent = 'UI konnte nicht geladen werden'; byId('description').textContent = error.message; });
</script>
</body></html>`;
