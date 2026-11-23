// Voz do Google (Gemini TTS): gera um WAV com a fala do aviso.
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';

const PASTA = path.join(DADOS, 'voz');
fs.mkdirSync(PASTA, { recursive: true });

function wav(pcm, taxa = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(taxa, 24); h.writeUInt32LE(taxa * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function gerar(texto, modelo) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiChave },
    body: JSON.stringify({
      // Só o texto: instrução de estilo junto do texto acabava sendo lida em voz alta.
      contents: [{ parts: [{ text: config.vozEstilo ? `${config.vozEstilo}\n\n${texto}` : texto }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.vozGoogle } } },
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`voz Google ${r.status}: ${j.error?.message?.slice(0, 140) || r.statusText}`);
  const parte = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!parte) throw new Error('voz Google: resposta sem áudio');
  const taxa = Number(/rate=(\d+)/.exec(parte.inlineData.mimeType || '')?.[1] || 24000);
  return wav(Buffer.from(parte.inlineData.data, 'base64'), taxa);
}

/** Gera o áudio e devolve o caminho do WAV (tenta o modelo principal e depois o lite). */
export async function vozGoogle(texto) {
  let erro;
  for (const m of [config.vozGoogleModelo, 'gemini-3.8-flash-lite-tts']) {
    try {
      const arq = path.join(PASTA, `aviso-${Date.now()}.wav`);
      fs.writeFileSync(arq, await gerar(texto, m));
      // guarda só os 20 últimos áudios
      const velhos = fs.readdirSync(PASTA).filter((f) => f.endsWith('.wav')).sort().slice(0, -20);
      for (const f of velhos) try { fs.unlinkSync(path.join(PASTA, f)); } catch {}
      return arq;
    } catch (e) { erro = e; }
  }
  throw erro;
}
