// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito em cópias e versões modificadas)
// Monta o instalador do "Ligar o PC" (roda no NOTEBOOK) já preenchido com os dados deste PC:
// endereço físico (MAC) da placa de rede, IP, porta e o link do Vigia. Servido em /notebook/ligar-pc.zip?k=...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, DADOS, RAIZ } from './config.js';

const MODELOS = path.join(RAIZ, 'notebook');

/** Placa de rede da rede local (192.168.x / 10.x / 172.16-31.x): { ip, mac, broadcast } */
export function placaLocal() {
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const a of lista || []) {
      if (a.family !== 'IPv4' || a.internal || !a.mac || a.mac === '00:00:00:00:00:00') continue;
      if (!/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      const broadcast = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.');
      return { ip: a.address, mac: a.mac.toUpperCase().replace(/:/g, '-'), broadcast };
    }
  }
  return null;
}

// Falas do notebook, gravadas com a mesma voz do Vigia (Francisca) e tocadas lá como arquivo
const FALAS = {
  'ligando.wav': 'Ligando o PC.',
  'nao-ligou.wav': 'O PC não ligou. Confira se ele está na tomada e no cabo de rede.',
};

/** Gera dados/ligar-pc.zip e devolve o caminho (ou null). */
export async function montarLigarPc(chave) {
  const placa = placaLocal();
  if (!placa) return null;
  const valores = {
    MAC: placa.mac, IP: placa.ip, PORTA: String(config.altoFalantePorta), BROADCAST: placa.broadcast,
    LINK: `http://${placa.ip}:${config.altoFalantePorta}/?k=${chave}`,
  };
  const pasta = path.join(DADOS, 'ligar-pc');
  fs.rmSync(pasta, { recursive: true, force: true });
  fs.mkdirSync(pasta, { recursive: true });
  for (const nome of fs.readdirSync(MODELOS)) {
    let t = fs.readFileSync(path.join(MODELOS, nome), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => valores[k] ?? m);
    if (nome.endsWith('.ps1')) t = '﻿' + t.replace(/^﻿/, ''); // PowerShell 5.1 precisa do BOM para ler acentos
    if (nome.endsWith('.bat')) t = t.replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(path.join(pasta, nome), t, 'utf8');
  }
  const { gerarAudioArquivo } = await import('./avisos.js');
  for (const [nome, texto] of Object.entries(FALAS)) {
    try { const wav = await gerarAudioArquivo(texto); if (wav) fs.copyFileSync(wav, path.join(pasta, nome)); } catch {}
  }
  const icone = new URL('../assets/vigia.ico', import.meta.url);
  if (fs.existsSync(icone)) fs.copyFileSync(icone, path.join(pasta, 'vigia.ico'));
  const zip = path.join(DADOS, 'ligar-pc.zip');
  fs.rmSync(zip, { force: true });
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${pasta}\\*' -DestinationPath '${zip}' -Force`], { windowsHide: true });
  return r.status === 0 && fs.existsSync(zip) ? zip : null;
}
