// Pontuação do texto ditado. O reconhecimento de voz do Chrome (notebook) devolve tudo sem vírgula, ponto ou
// interrogação ("oi tudo bem chego às sete pode ser"). Antes de ler de volta e enviar, coloca a pontuação:
// 1) pelo Gemini, que só pode mexer em pontuação e maiúsculas (se mudar qualquer palavra, a resposta é descartada);
// 2) se o Gemini falhar ou demorar, por uma regra simples (maiúscula no começo, "?" em pergunta, "." no fim).
import { config } from './config.js';

const PERGUNTA = /^(que|qual|quais|quando|onde|aonde|como|quem|quanto|quantos|quantas|por ?que|pq|cad[eê]|ser[aá]|ser[aá] que|vc vai|voc[eê] (vai|pode|quer|est[aá]|t[aá]|tem|sabe|viu|acha)|tu (vai|pode|quer)|pode|posso|podemos|vamos|bora|tem como|t[aá] (a[ií]|bem|tudo)|tudo bem|j[aá]|e a[ií]|e voc[eê]|n[eé])\b/i;
const FIM_PERGUNTA = /\b(n[eé]|ok|t[aá]|beleza|blz|certo|sim ou n[aã]o|pode ser|t[aá] bom|tudo bem|combinado|que tal|viu)$/i;

const soPalavras = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Regra simples, sem IA. */
export function pontuarLocal(texto) {
  let t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (!t) return t;
  t = t[0].toUpperCase() + t.slice(1);
  if (/[.!?…]$/.test(t)) return t;
  // "beleza" sozinho é resposta, não pergunta: o fim só vale em frase com mais palavras
  const pergunta = PERGUNTA.test(t.normalize('NFC')) || (t.split(' ').length > 2 && FIM_PERGUNTA.test(t));
  return t + (pergunta ? '?' : '.');
}

async function pontuarGemini(texto) {
  if (!config.geminiChave) throw new Error('sem chave');
  const modelo = config.geminiModelo || 'gemini-flash-lite-latest';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiChave },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text:
        'Você recebe uma mensagem de WhatsApp ditada por voz em português do Brasil, sem pontuação. ' +
        'Devolva a MESMA mensagem só com a pontuação certa (vírgulas, pontos, interrogação, exclamação) e letras maiúsculas onde precisa. ' +
        'NÃO troque, NÃO corrija, NÃO acrescente e NÃO tire nenhuma palavra, nem gírias ou abreviações. Responda só com a mensagem.' }] },
      contents: [{ role: 'user', parts: [{ text: texto }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1000 },
    }),
    signal: AbortSignal.timeout(8000), // às vezes o Google leva ~10 s; depois disso vale a regra simples
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const j = await r.json();
  const saida = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim().replace(/^["“]|["”]$/g, '');
  // segurança: se alguma palavra mudou, não usa
  if (!saida || soPalavras(saida) !== soPalavras(texto)) throw new Error('a IA mudou palavras');
  return saida;
}

/** Texto ditado → texto pontuado. Se já veio pontuado (transcrição do Gemini), não mexe. */
export async function pontuar(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (!t || /[.,!?;:]/.test(t)) return t;
  if (t.split(' ').length < 3) return pontuarLocal(t); // "sim", "tô indo": não precisa de IA
  try { return await pontuarGemini(t); }
  catch { return pontuarLocal(t); }
}
