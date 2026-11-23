// Grava o microfone só quando chamado (janela curta), com detecção de fala local:
// nada é enviado se ninguém falar. Devolve um WAV (16 kHz mono) só com o trecho falado.
import { spawn, spawnSync } from 'node:child_process';
import { config } from './config.js';
import { log } from './avisos.js';

let dispositivo;
export function microfone() {
  if (dispositivo !== undefined) return dispositivo;
  if (config.microfone) return (dispositivo = config.microfone);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8', windowsHide: true });
  const nomes = [...String(r.stderr).matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1]);
  // prefere headset/USB; senão o primeiro
  dispositivo = nomes.find((n) => !/realtek|stereo mix|mixagem/i.test(n)) || nomes[0] || null;
  log(dispositivo ? `Microfone: ${dispositivo}` : 'Nenhum microfone encontrado: respostas por voz desligadas.');
  return dispositivo;
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * esperaMs: quanto tempo espera a pessoa começar a falar
 * silencioMs: quanto silêncio depois da fala encerra a gravação
 * maxMs: duração máxima da fala
 * → Buffer WAV, ou null se ninguém falou
 */
/** O microfone do notebook (página do alto-falante) está disponível agora? */
export async function micRemotoAtivo() {
  if (config.micOrigem === 'pc' || config.saidaVoz === 'pc') return false;
  const af = await import('./alto-falante.js');
  return af.temMic();
}

/** Ouve pelo notebook quando ele estiver conectado com microfone liberado; senão, pelo microfone do PC. */
export async function ouvir(opcoes = {}) {
  if (await micRemotoAtivo()) {
    const af = await import('./alto-falante.js');
    return af.ouvirRemoto(opcoes);
  }
  return ouvirLocal(opcoes);
}

function ouvirLocal({ esperaMs = 7000, silencioMs = 1400, maxMs = 20000 } = {}) {
  const dev = microfone();
  if (!dev) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${dev}`,
      '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const QUADRO = 3200; // 100 ms
    let resto = Buffer.alloc(0);
    const quadros = [];
    let n = 0, ruido = [], limiar = null, falando = false, inicioFala = -1, silencio = 0, seguidos = 0, fim = false;
    let erro = '';
    ff.stderr.on('data', (d) => (erro += d));

    const terminar = (resultado) => {
      if (fim) return; fim = true;
      try { ff.kill(); } catch {}
      resolve(resultado);
    };
    const tempoLimite = setTimeout(() => terminar(falando ? wav(Buffer.concat(quadros.slice(Math.max(0, inicioFala - 3)))) : null), esperaMs + maxMs + 2000);

    ff.stdout.on('data', (d) => {
      resto = Buffer.concat([resto, d]);
      while (resto.length >= QUADRO && !fim) {
        const q = resto.subarray(0, QUADRO); resto = resto.subarray(QUADRO);
        quadros.push(Buffer.from(q)); n++;
        let soma = 0;
        for (let i = 0; i < q.length; i += 2) { const s = q.readInt16LE(i); soma += s * s; }
        const db = 20 * Math.log10(Math.sqrt(soma / (q.length / 2)) / 32768 + 1e-9);
        if (n <= 2) continue;                                      // descarta o estalo de abertura do microfone
        if (n <= 5) ruido.push(db);                                // 300 ms: estima o ruído (sem atrasar a escuta)
        if (limiar === null && n >= 5) {
          // usa o trecho MAIS BAIXO (se a pessoa já começou a falar, a fala não vira "ruído")
          const piso = Math.min(...ruido);
          limiar = Math.min(config.micLimiar, Math.max(-55, piso + 12)); // nunca exige mais que MIC_LIMIAR (-45 dB)
          if (process.env.MIC_DEBUG) log(`microfone: ruído ${piso.toFixed(1)} dB, limiar ${limiar.toFixed(1)} dB`);
        }
        if (limiar === null) continue;
        if (process.env.MIC_DEBUG && n % 5 === 0) log(`microfone: ${db.toFixed(1)} dB`);
        if (!falando) {
          seguidos = db > limiar ? seguidos + 1 : 0;
          if (seguidos >= 2) { falando = true; inicioFala = Math.max(3, n - 2); }
          else if (n * 100 > esperaMs + 700) { clearTimeout(tempoLimite); return terminar(null); }
        } else {
          silencio = db > limiar ? 0 : silencio + 100;
          const duracao = (n - inicioFala) * 100;
          if (silencio >= silencioMs || duracao >= maxMs) {
            clearTimeout(tempoLimite);
            return terminar(wav(Buffer.concat(quadros.slice(Math.max(0, inicioFala - 3)))));
          }
        }
      }
    });
    ff.on('error', (e) => { log(`microfone: ${e.message}`); clearTimeout(tempoLimite); terminar(null); });
    ff.on('close', (code) => {
      if (!fim && code) log(`microfone: ffmpeg saiu (${erro.trim().slice(0, 160)})`);
      clearTimeout(tempoLimite); terminar(falando ? wav(Buffer.concat(quadros.slice(Math.max(0, inicioFala - 3)))) : null);
    });
  });
}
