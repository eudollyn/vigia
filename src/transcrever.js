// Transcreve um WAV curto com o Gemini (fala em português).
import { config } from './config.js';

/** dica: lista de nomes que podem aparecer na fala (ajuda a acertar a grafia de contatos). */
export async function transcrever(wavBuf, dica = [], mime = 'audio/wav') {
  const vocab = dica.length ? ` A pessoa provavelmente está dizendo um destes nomes (use a grafia exata se for um deles): ${dica.slice(0, 600).join('; ')}.` : '';
  if (!wavBuf || !config.geminiChave) return '';
  const modelos = [...new Set([config.geminiModelo, ...config.geminiReservas])];
  let ultimo;
  for (const m of modelos) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiChave },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: 'Transcreva exatamente o que a pessoa falou neste áudio, em português do Brasil, com pontuação natural. Não traduza, não resuma, não responda ao conteúdo. Se não houver fala clara, devolva texto vazio.' + vocab + ' Responda só JSON: {"texto":"..."}' },
            { inlineData: { mimeType: mime, data: wavBuf.toString('base64') } },
          ] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
        signal: AbortSignal.timeout(mime === 'audio/wav' ? 12_000 : 40_000), // áudios do WhatsApp podem ser longos
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`transcrição ${r.status}: ${j.error?.message?.slice(0, 120) || r.statusText}`);
      const out = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      try { return String(JSON.parse(out).texto || '').trim(); } catch { return out.replace(/[{}"]/g, '').replace(/^texto:\s*/i, '').trim(); }
    } catch (e) { ultimo = e; }
  }
  throw ultimo;
}
