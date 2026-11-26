import {Terminal} from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './workspace.css';
import {checkSize, commandLines, decodeProject, encodeProject, example, extension, maxScriptBytes} from './project.mjs';

const revision = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const basename = path => path.split('/').at(-1);

function validName(value) {
  if (!value || value === '.' || value === '..' || /[\\/:\u0000-\u001f]/.test(value)) throw Error('Enter a valid file name.');
  return value;
}

function filesPath(value, folder = false) {
  const path = value.replace(/^(?:(?:webos|browser):)?\//, '');
  if (folder && !path) return path;
  path.split('/').forEach(validName);
  if (path === '.app' || path.startsWith('.app/')) throw Error('Choose a folder outside app settings.');
  if (!folder && !path.toLowerCase().endsWith(extension)) throw Error('Choose a .riscvlab.json project.');
  return path;
}

export function mount(host) {
  const {make, textButton} = host.ui;
  const owner = host.storage.workspaceOwner();
  const session = host.session();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, host.signal]);
  const element = make('section', 'window-content riscv-machine-lab');
  const panel = make('div', 'riscv-project');
  const toolbar = make('div', 'riscv-project-actions');
  const status = make('p', 'riscv-status', 'Starting RISC-V Machine Lab…');
  status.setAttribute('role', 'status');
  const source = document.createElement('textarea');
  source.setAttribute('aria-label', 'xv6 command script');
  source.setAttribute('autocapitalize', 'off');
  source.spellcheck = false;
  source.value = example;
  const serial = make('div', 'riscv-terminal');
  serial.setAttribute('aria-label', 'xv6 serial console');
  const legal = document.createElement('a');
  legal.textContent = 'Source and licenses';
  legal.href = new URL('./legal/NOTICES.txt', import.meta.url).href;
  legal.target = '_blank';
  legal.rel = 'noopener';
  const terminal = new Terminal({cols: 80, rows: 25, fontSize: 14, convertEol: true, cursorBlink: true});
  let context, binding, releaseWriter, worker, startup, scriptTimer;
  let clean = source.value, busy = false, transferring = false;
  let atPrompt = false, tail = '', script = null;

  const tell = message => { if (!signal.aborted) status.textContent = message; };
  const dirty = () => source.value !== clean;
  const valid = () => !signal.aborted && host.session() === session && host.storage.workspaceOwner() === owner && context?.valid();

  function workspace() {
    if (!valid()) throw new DOMException('This Files workspace ended.', 'AbortError');
    if (transferring) throw Error('Files are being transferred.');
    return context.files;
  }

  function bind(file) {
    workspace();
    if (!binding && !file) return;
    host.desktop.updateAccountFileBinding(host.w, {owner, path: file?.path ?? null, sha256: file?.sha256 ?? null});
    binding = file;
  }

  async function confirmDiscard() {
    if (!dirty()) return true;
    workspace();
    const captured = source.value;
    const answer = await host.ui.confirm('Discard unsaved changes to the xv6 command script?', {
      title: 'Unsaved changes', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true, signal,
    });
    return answer && valid() && source.value === captured;
  }

  function fileAction(action) {
    return async () => {
      if (busy) return;
      busy = true;
      try {
        workspace();
        await action();
      } catch (error) {
        if (error.name !== 'AbortError') tell(error.message);
      } finally {
        busy = false;
      }
    };
  }

  async function open(path, expected) {
    const {data, sha256} = await workspace().read(path, {signal});
    workspace();
    if (!revision.test(sha256) || expected && sha256 !== expected) throw Error('Open the current revision from Files.');
    if (data.byteLength > maxScriptBytes * 7) throw Error('The command script exceeds 16 KiB.');
    const value = decodeProject(new TextDecoder('utf-8', {fatal: true}).decode(data));
    if (!await confirmDiscard()) return;
    bind({path, sha256});
    source.value = value;
    clean = source.value;
    tell('Opened ' + basename(path) + ' from Files.');
  }

  const pick = fileAction(async () => {
    const selected = await host.storage.pickWorkspaceFile({extensions: [extension], signal});
    if (selected != null) await open(filesPath(selected));
  });

  function save(copy) {
    return fileAction(async () => {
      const value = source.value;
      checkSize(value);
      let path = copy ? null : binding?.path;
      const expected = path ? binding.sha256 : null;
      if (!path) {
        const folder = await host.storage.pickWorkspaceFile({foldersOnly: true, signal});
        if (folder == null) return;
        const choice = await host.ui.prompt('Project name', {
          title: 'Save RISC-V project', value: 'xv6' + extension, confirmLabel: 'Save', signal,
        });
        if (choice == null) return;
        let name = validName(choice.trim());
        if (!name.toLowerCase().endsWith(extension)) {
          if (name.includes('.')) throw Error('Use a .riscvlab.json filename.');
          name += extension;
        }
        const parent = filesPath(folder, true);
        path = filesPath(parent ? parent + '/' + name : name);
      }
      try {
        const result = await workspace().write(path, encoder.encode(encodeProject(value)), expected, {signal});
        if (!revision.test(result.sha256)) throw Error('Files did not confirm the save.');
        bind({path, sha256: result.sha256});
        clean = value;
        tell(dirty() ? 'Saved ' + basename(path) + '. Newer edits are still unsaved.' : 'Saved ' + basename(path) + ' in Files.');
      } catch (error) {
        if (error.status !== 409) throw error;
        throw Error(expected ? 'This project changed in Files. Use Save As to keep both versions.' :
          'A project already has that name. Choose another name.');
      }
    });
  }

  const newProject = fileAction(async () => {
    if (!await confirmDiscard()) return;
    bind(null);
    source.value = '';
    clean = '';
    tell('New xv6 project.');
  });

  function stop() {
    worker?.terminate();
    worker = null;
    atPrompt = false;
    tail = '';
    script = null;
    clearTimeout(startup);
    clearTimeout(scriptTimer);
    startup = null;
  }
  signal.addEventListener('abort', stop, {once: true});

  function sendText(value) {
    atPrompt = false;
    tail = '';
    const bytes = encoder.encode(value);
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      worker.postMessage({type: 'input', bytes: bytes.subarray(offset, offset + 4096)});
    }
  }

  function advanceScript() {
    if (!atPrompt || !script) return;
    clearTimeout(scriptTimer);
    const line = script.shift();
    if (line === undefined) {
      script = null;
      tell('xv6 command script finished.');
      return;
    }
    sendText(line + '\n');
    scriptTimer = setTimeout(() => {
      script = null;
      tell('The script is waiting for an xv6 prompt. You can continue in the console.');
    }, 30000);
  }

  function boot() {
    if (!valid() || transferring || worker) return;
    terminal.reset();
    tell('Booting xv6…');
    terminal.writeln('Booting xv6…');
    const machine = new Worker(new URL('./native/worker.mjs', import.meta.url), {type: 'module'});
    worker = machine;
    function failed(message) {
      if (worker !== machine) return;
      stop();
      terminal.writeln(message);
      tell(message);
    }
    startup = setTimeout(() => failed('xv6 did not reach a shell prompt.'), 120000);
    machine.onerror = () => failed('Could not start the RISC-V worker.');
    machine.onmessage = ({data}) => {
      if (worker !== machine) return;
      if (data.type === 'error') { failed(data.message); return; }
      if (data.type !== 'output') return;
      terminal.write(data.text);
      tail = (tail + data.text).slice(-128);
      atPrompt = /(?:^|[\r\n])\$ $/.test(tail);
      if (atPrompt && startup) {
        clearTimeout(startup);
        startup = null;
        tell('xv6 is ready.');
      }
      advanceScript();
    };
    machine.postMessage({type: 'boot'});
  }

  function runScript() {
    if (!valid() || transferring || script) return;
    if (!atPrompt || !worker) {
      tell('Boot xv6 and wait for its shell prompt.');
      return;
    }
    try {
      script = commandLines(source.value);
      tell('Running the xv6 command script…');
      advanceScript();
    } catch (error) {
      tell(error.message);
    }
  }

  function stopMachine() {
    if (!worker || transferring) return;
    stop();
    terminal.writeln('\r\nxv6 stopped.');
    tell('xv6 stopped.');
  }

  function focusConsole() {
    serial.scrollIntoView({block: 'nearest'});
    terminal.focus();
  }

  toolbar.append(textButton('New', newProject), textButton('Open', pick), textButton('Save', save(false)),
    textButton('Save As', save(true)), textButton('Boot xv6', boot), textButton('Stop', stopMachine),
    textButton('Run script', runScript), textButton('Console', focusConsole));
  panel.append(toolbar, source, status, legal);
  element.append(panel, serial);
  terminal.open(serial);
  terminal.writeln('Boot xv6 to start the serial console.');
  terminal.onData(value => {
    if (worker && valid() && !transferring && !script) sendText(value.replaceAll('\r', '\n'));
  });
  const size = new ResizeObserver(([entry]) => {
    const {width, height} = entry.contentRect;
    if (width > 0 && height > 0) terminal.resize(Math.max(30, Math.floor(width / 9)), Math.max(8, Math.floor(height / 18)));
  });
  size.observe(serial);

  const ready = (async () => {
    context = await host.storage.workspaceFileContext();
    if (context.owner !== owner) throw Error('The RISC-V editor belongs to another Files workspace.');
    workspace();
    releaseWriter = context.registerFileWriter?.(async () => {
      if (dirty() || busy) throw Error('Finish saving the xv6 project before transferring Files.');
      transferring = true;
      element.inert = true;
      return () => { element.inert = false; transferring = false; };
    });
    const launch = host.w.launchContext;
    if (launch) {
      if (launch.storage !== 'account' || launch.owner !== owner) throw Error('Open the project from My files.');
      await open(filesPath(launch.path), launch.restore ? undefined : launch.sha256);
    } else {
      tell('Boot xv6 or open a project from Files.');
    }
  })();
  ready.catch(error => tell(error.message));
  window.addEventListener('beforeunload', event => {
    if (!dirty() && !busy) return;
    event.preventDefault();
    event.returnValue = '';
  }, {signal});
  return {
    element,
    ready,
    focus: () => source.focus(),
    async requestClose() {
      if (busy || transferring) {
        tell('Finish the file operation before closing RISC-V Machine Lab.');
        return false;
      }
      return confirmDiscard();
    },
    dispose() {
      lifetime.abort();
      releaseWriter?.();
      size.disconnect();
      terminal.dispose();
    },
  };
}
