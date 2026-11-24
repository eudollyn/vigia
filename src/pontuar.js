// Pontuação do texto ditado. O reconhecimento de voz do Chrome (notebook) devolve tudo sem vírgula, ponto ou
// interrogação ("oi tudo bem chego às sete pode ser"). Antes de ler de volta e enviar, coloca a pontuação:
// 1) pelo Gemini, que só pode mexer em pontuação e maiúsculas (se mudar qualquer palavra, a resposta é descartada);
// 2) se o Gemini falhar ou demorar, por uma regra simples (maiúscula no começo, "?" em pergunta, "." no fim).
import { config } from './config.js';

const PERGUNTA = /^(que|qual|quais|quando|onde|aonde|como|quem|quanto|quantos|quantas|por ?que|pq|cad[eê]|ser[aá]|ser[aá] que|vc vai|voc[eê] (vai|pode|quer|est[aá]|t[aá]|tem|sabe|viu|acha)|tu (vai|pode|quer)|pode|posso|podemos|vamos|bora|tem como|t[aá] (a[ií]|bem|tudo)|tudo bem|j[aá]|e a[ií]|e voc[eê]|n[eé])\b/i;
const FIM_PERGUNTA = /\b(n[eé]|ok|t[aá]|beleza|blz|certo|sim ou n[aã]o|pode ser|t[aá] bom|tudo bem|combinado|que tal|viu)$/i;

// quantas palavras foram trocadas, tiradas ou acrescentadas (distância de edição por palavra)
function distanciaPalavras(a, b) {
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const at = [i];
    for (let j = 1; j <= b.length; j++) at[j] = Math.min(ant[j] + 1, at[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    ant = at;
  }
  return ant[b.length];
}
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

async function pontuarGemini(texto, modelo = config.geminiModelo || 'gemini-flash-lite-latest', espera = 8000) {
  if (!config.geminiChave) throw new Error('sem chave');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiChave },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text:
        'Você recebe uma mensagem de WhatsApp ditada por voz em português do Brasil, sem pontuação. ' +
        'Devolva a MESMA mensagem só com a pontuação certa (vírgulas, pontos, interrogação, exclamação) e letras maiúsculas onde precisa. ' +
        'Ajuste também maiúsculas erradas no meio da frase. Mantenha as palavras, as gírias e o jeito de falar da pessoa: ' +
        'só corrija uma palavra se ela for claramente um erro do reconhecimento de voz (ex.: "chat de PT" → "ChatGPT"). ' +
        'NÃO resuma, NÃO reescreva, NÃO acrescente nem tire frases. Responda só com a mensagem.' }] },
      contents: [{ role: 'user', parts: [{ text: texto }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1000 },
    }),
    signal: AbortSignal.timeout(espera),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const j = await r.json();
  const saida = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim().replace(/^["“]|["”]$/g, '');
  // segurança: aceita pequenas correções do reconhecimento de voz ("chat de PT" → "chat GPT"),
  // mas se a IA reescreveu a mensagem (mais de 2 palavras ou 10% do texto), não usa
  if (!saida) throw new Error('resposta vazia');
  const a = soPalavras(texto).split(' '), b = soPalavras(saida).split(' ');
  const limite = Math.max(2, Math.ceil(a.length * 0.1));
  if (distanciaPalavras(a, b) > limite) throw new Error('a IA mudou palavras demais');
  return saida;
}

/** Texto ditado → texto pontuado. Se já veio pontuado (transcrição do Gemini), não mexe. */
export async function pontuar(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (!t || /[.,!?;:]/.test(t)) return t;
  if (t.split(' ').length < 3) return pontuarLocal(t); // "sim", "tô indo": não precisa de IA
  // o modelo principal (até 6 s) e, se ele falhar ou demorar, um reserva (até 6 s); só então a regra simples
  const modelos = [...new Set([config.geminiModelo || 'gemini-flash-lite-latest', ...(config.geminiReservas || [])])].slice(0, 2);
  const erros = [];
  ultimoErro = '';
  for (const m of modelos) {
    try { return await pontuarGemini(t, m, 6000); }
    catch (e) { erros.push(`${m}: ${e.message}`); }
  }
  ultimoErro = erros.join(' | ');
  return pontuarLocal(t);
}
export let ultimoErro = ''; // para o log: por que caiu na regra simples
