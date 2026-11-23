// Voz neural da Microsoft (a mesma do "Ler em voz alta" do Edge). Grátis, sem chave.
// Gera MP3 e converte para WAV com o ffmpeg (o Windows toca WAV sem programa extra).
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';

const PASTA = path.join(DADOS, 'voz');
fs.mkdirSync(PASTA, { recursive: true });

const escapar = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

async function sintetizar(texto, voz) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voz, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapar(texto), { rate: config.vozMsVelocidade });
    const partes = [];
    await new Promise((ok, falha) => {
      const t = setTimeout(() => falha(new Error('voz Microsoft: tempo esgotado')), 20_000);
      audioStream.on('data', (d) => partes.push(d));
      audioStream.on('end', () => { clearTimeout(t); ok(); });
      audioStream.on('close', () => { clearTimeout(t); ok(); });
      audioStream.on('error', (e) => { clearTimeout(t); falha(e); });
    });
    const mp3 = Buffer.concat(partes);
    if (mp3.length < 500) throw new Error('voz Microsoft: áudio vazio');
    return mp3;
  } finally { try { tts.close(); } catch {} }
}

function mp3ParaWav(mp3, wav) {
  return new Promise((ok, falha) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'mp3', '-i', 'pipe:0', '-ac', '1', '-ar', '24000', wav], { windowsHide: true });
    let err = '';
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', falha);
    ff.on('close', (c) => (c ? falha(new Error(`ffmpeg: ${err.trim().slice(0, 120)}`)) : ok(wav)));
    ff.stdin.end(mp3);
  });
}

/** Gera a fala e devolve o caminho do WAV. */
export async function vozMicrosoft(texto, voz = config.vozMs) {
  const arq = path.join(PASTA, `aviso-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
  await mp3ParaWav(await sintetizar(texto, voz), arq);
  const velhos = fs.readdirSync(PASTA).filter((f) => f.startsWith('aviso-')).sort().slice(0, -20);
  for (const f of velhos) try { fs.unlinkSync(path.join(PASTA, f)); } catch {}
  return arq;
}
