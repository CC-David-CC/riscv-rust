export const extension = '.riscvlab.json';
export const maxScriptBytes = 16 * 1024;
export const example = 'echo Hello from xv6\nls\n';
const format = 'riscv-machine-lab/1';
const machine = 'xv6';
const encoder = new TextEncoder();

export function decodeProject(text) {
  const project = JSON.parse(text);
  if (project?.format !== format || project.machine !== machine || typeof project.script !== 'string') {
    throw Error('Choose an xv6 project created by RISC-V Machine Lab.');
  }
  checkSize(project.script);
  return project.script;
}

export function checkSize(script) {
  if (encoder.encode(script).length > maxScriptBytes) throw Error('The command script exceeds 16 KiB.');
}

export function encodeProject(script) {
  checkSize(script);
  return JSON.stringify({format, machine, script}, null, 2) + '\n';
}

export function commandLines(script) {
  checkSize(script);
  const lines = script.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  if (!lines.length) throw Error('Enter one or more xv6 shell commands.');
  if (lines.some(line => encoder.encode(line).length > 98 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(line))) {
    throw Error('Use at most 98 bytes of text per xv6 command.');
  }
  return lines;
}
