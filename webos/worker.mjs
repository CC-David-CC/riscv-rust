import init, {WasmRiscv} from './riscv_emu_rust_wasm.js';

const input = [];
const decoder = new TextDecoder();
const bytes = new Uint8Array(8192);
let machine, started = false;

async function fetchAsset(name) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw Error('Could not load ' + name + ' (' + response.status + ').');
  return new Uint8Array(await response.arrayBuffer());
}

function cycle() {
  try {
    for (const byte of input.splice(0)) machine.put_input(byte);
    machine.run_cycles(0x100000);
    let length = 0;
    while (length < bytes.length) {
      const byte = machine.get_output();
      if (byte === 0) break;
      bytes[length++] = byte;
    }
    if (length) postMessage({type: 'output', text: decoder.decode(bytes.subarray(0, length), {stream: true})});
    setTimeout(cycle, 0);
  } catch (error) {
    postMessage({type: 'error', message: error.message});
  }
}

self.onmessage = async ({data}) => {
  if (data.type === 'input' && machine) {
    input.push(...data.bytes);
    return;
  }
  if (data.type !== 'boot' || started) return;
  started = true;
  try {
    const [kernel, disk] = await Promise.all([fetchAsset('./kernel.data'), fetchAsset('./fs.data'), init()]);
    machine = WasmRiscv.new();
    machine.setup_program(kernel);
    machine.setup_filesystem(disk);
    machine.enable_page_cache(true);
    cycle();
  } catch (error) {
    postMessage({type: 'error', message: error.message});
  }
};
