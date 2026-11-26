// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito em cópias e versões modificadas)
// Conversa por voz depois de um aviso do WhatsApp:
//   (aviso lido) → microfone abre → "responda" → "O que você quer responder?" → ditado →
//   "Vou responder: ... Posso enviar?" → "enviar" envia / qualquer outra coisa cancela.
// Nada é enviado sem o "enviar" dito por você.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config, DADOS } from './config.js';
import { log, tocarArquivo, notificar } from './avisos.js';

// bipe de 0,15 s a 880 Hz, gerado uma vez
function criarBipe() {
  const arq = path.join(DADOS, 'bipe.wav');
  if (fs.existsSync(arq)) return arq;
  const taxa = 24000, n = Math.round(taxa * 0.15), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 240, (n - i) / 240);
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 880 * i) / taxa) * 9000 * env), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(taxa, 24);
  h.writeUInt32LE(taxa * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(arq, Buffer.concat([h, pcm]));
  return arq;
}
import { ouvir, micRemotoAtivo } from './microfone.js';
import { transcrever } from './transcrever.js';

const PEDIU_RESPOSTA = /\b(respond[aeo]r?|responde|resposta|responda)\b/i;
// Confirmação: frase CURTA (até 5 palavras) com uma palavra de "sim". Frase longa = correção do texto.
const PALAVRA_SIM = /\b(envia[r]?|envie|enviou|manda[r]?|mande|manda ver|sim|pode|confirm[ao]|confirmado|isso|ok|okay|beleza|certo|perfeito|claro|bora)\b/i;
const CANCELA = /\b(cancela[r]?|cancele|nao|deixa pra la|deixa|esquece|para tudo)\b/i;
const palavras = (s) => s.split(/\s+/).filter(Boolean).length;
export const confirmou = (s) => palavras(s) <= 5 && PALAVRA_SIM.test(s) && !CANCELA.test(s);

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

let bipe;
async function ouvirTexto(opcoes, rotulo, dica = []) {
  if (!bipe) bipe = criarBipe();
  // no ditado de mensagem, a página marca onde você pausou (" | "): as pausas viram vírgula/ponto em pontuar.js
  if (rotulo === 'ditado') opcoes = { ...opcoes, pausas: true };
  log(`voz: escutando (${rotulo})…`);
  const remoto = await micRemotoAtivo();       // no notebook, a própria página toca o bipe
  const gravando = ouvir(opcoes);              // abre o microfone já
  if (!remoto) setTimeout(() => tocarArquivo(bipe), 350); // bipe curto quando o microfone já está aberto: "pode falar"
  const audio = await gravando;
  falhouTranscricao = false;
  if (!audio) { log(`voz: ninguém falou (${rotulo})`); return ''; }
  if (audio.texto !== undefined) { log(`voz: entendi (${rotulo}, Chrome) "${audio.texto}"`); return audio.texto; } // texto pronto do notebook
  try { return await transcrever(audio, dica); }
  catch (e) { log(`transcrição falhou: ${e.message}`); falhouTranscricao = true; return ''; }
}
// Se a fala foi gravada mas o Google não transcreveu (cota/instabilidade), não dizer "não ouvi nada".
let falhouTranscricao = false;
const naoOuvi = (resto) => (falhouTranscricao
  ? `Ouvi, mas não consegui entender agora: o Google está fora do ar ou o limite grátis acabou. ${resto}`
  : `Não ouvi nada. ${resto}`);

/**
 * item: aviso de WhatsApp com { de, grupo?, jid }
 * dizer(texto) → Promise que termina quando a fala acaba
 * enviar(jid, texto) → Promise
 */
export async function talvezResponder(item, { dizer, enviar, pedido: jaPedido = "" }) {
  if (!config.responderVoz || !item.jid || !enviar) return;

  // 1) janela curta esperando "responda" (ou o "responda" já veio do comando de voz do notebook)
  const pedido = jaPedido || await ouvirTexto({ esperaMs: config.janelaMs, silencioMs: 900, maxMs: 15000, automatico: true }, 'responda?');
  if (!pedido) return;
  if (jaPedido) await dizer(`Respondendo para ${item.grupo ? 'o grupo ' + item.grupo : item.de}.`);
  if (!PEDIU_RESPOSTA.test(semAcento(pedido))) { log(`voz: ouvi "${pedido}" (não era "responda")`); return; }

  const para = item.grupo ? `o grupo ${item.grupo}` : item.de;
  // "responda: estou chegando" já traz o texto junto
  let texto = pedido.replace(/^.*?\b(respond[aeo]r?|responde|responda)\b[\s,:.-]*/i, '').trim();
  if (texto.split(/\s+/).filter(Boolean).length < 2) {
    await dizer('O que você quer responder?');
    texto = await ouvirTexto({ esperaMs: 8000, silencioMs: 1600, maxMs: 45000 }, 'ditado');
    if (!texto) { await dizer(naoOuvi('Cancelei.')); return; }
    if (desistiu(texto)) { log(`voz: desistiu de responder ("${texto}")`); await dizer('Tudo bem, não vou responder.'); return; }
  }
  return confirmarEEnviar(item, texto, { dizer, enviar, verbo: 'responder' });
}

// "Não", "nada", "cancela", "deixa pra lá", "esquece"… como resposta à pergunta = desistir (não vira mensagem)
// Só desiste quando a frase INTEIRA é de desistência ("Nada demais, só cansado" continua sendo uma resposta).
export const desistiu = (t) => {
  const s = semAcento(t).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bcancel(a|ar|e|ou|em)\b/.test(s)) return true; // "cancelar" em qualquer ponto da frase
  return /^(nao|nao nao|nada|nada nao|cancela|cancelar|cancele|cancela isso|deixa|deixa pra la|deixa quieto|esquece|esquece isso|nenhuma|nao quero|nao quero responder|nao quero enviar|nao quero mandar|nao precisa|nao precisa responder|agora nao|depois|depois eu respondo|nao obrigado|tudo bem nao)$/.test(s);
};

// "leia", "lê", "ler", "pode ler", "lê a mensagem", "o que diz"…
const PEDIU_LEITURA = /\b(leia|le|ler|leiam|lendo|o que (ela |ele )?(diz|disse|falou|fala))\b/;
// "ouça o áudio", "ouve o áudio", "toca o áudio", "escuta o áudio"…
const PEDIU_AUDIO = /\b(ouca|ouve|ouvir|ouça|escuta|escute|escutar|toca|toque|tocar|reproduz|reproduza)\b.*\baudio\b|^\W*(ouca|ouve|escuta|toca|toque)\W*$/;
// "encaminha essa mensagem para o Ana", "repassa isso pro grupo", "reenvia pro Bruno"
const PEDIU_ENCAMINHAR = /^\W*(pode\s+)?(encaminh\w*|repass\w*|reenvi\w*)\b/;
// "me lembra disso às três", "me lembra de responder daqui a uma hora"
const PEDIU_LEMBRETE = /^\W*(me\s+)?(lembra|lembre|lembrar|cria um lembrete|lembrete)\b/;
async function lembrarDisso(fala, item, dizer) {
  const { criarLembreteFalado } = await import('./comandos.js');
  // na janela do aviso, "me lembra às três" sem assunto também é sobre esta mensagem
  const sem = semAcento(fala).toLowerCase();
  const temAssunto = /\b(disso|isso|dessa|desse|essa|esse)\b/.test(sem) || /\b(de|que|pra|para)\s+\S/.test(sem.replace(/^\W*(me\s+)?(lembra|lembre|lembrar)\s+/, ''));
  const t = temAssunto ? fala : `${fala} disso`;
  log(`voz: lembrete sobre a mensagem de ${item.de}`);
  await dizer(await criarLembreteFalado(t, item));
}
// "abra o link", "abre", "abrir o link", "pode abrir"…
const PEDIU_LINK = /\b(abra|abre|abrir|abri)\b.{0,20}\blinks?\b|^\W*(pode\s+)?(abra|abre|abrir)\W*$/;

/**
 * Depois do aviso curto ("Mensagem de Fulano, no grupo X."): o microfone abre.
 *  - "leia"     → lê o resumo; depois abre de novo para um possível "responda" (só WhatsApp)
 *  - "responda" → vai direto para a resposta
 *  - nada       → fica só no aviso
 */
export async function aposAviso(item, { dizer, enviar }) {
  const podeResponder = item.canal === 'whatsapp' && item.jid && enviar;
  const pedido = await ouvirTexto({ esperaMs: config.janelaMs, silencioMs: 900, maxMs: 15000, automatico: true }, 'leia/responda?');
  if (!pedido) { if (falhouTranscricao) await dizer(naoOuvi('Diga leia de novo.')); return; }
  const p = semAcento(pedido).toLowerCase();
  if (podeResponder && PEDIU_RESPOSTA.test(p)) return talvezResponder(item, { dizer, enviar, pedido });
  // "me lembra disso às três": lembrete com esta mensagem
  if (PEDIU_LEMBRETE.test(p)) return lembrarDisso(pedido, item, dizer);
  // "encaminha essa mensagem para o Ana"
  if (PEDIU_ENCAMINHAR.test(p)) return (await import('./comandos.js')).encaminharFluxo(pedido, item);
  // "abra o link": abre no navegador do PC
  if (PEDIU_LINK.test(p)) {
    const { acharLink, abrirLink } = await import('./avisos.js');
    const url = acharLink(item.texto);
    if (!url) { await dizer('Essa mensagem não tem link.'); return; }
    log(`voz: abrindo o link de ${item.de}: ${url}`);
    if (await abrirLink(url)) await dizer('Abrindo o link no navegador.');
    else await dizer('Não consegui abrir esse link.');
    return;
  }
  const pediuAudio = PEDIU_AUDIO.test(p);
  if (!PEDIU_LEITURA.test(p) && !pediuAudio) { log(`voz: ouvi "${pedido}" (não era "leia", "ouça o áudio" nem "responda")`); return; }

  // áudio que não deu para transcrever na chegada (ou pedido "ouça o áudio"): transcreve agora ou toca o original
  const audioSemTexto = /^\[(enviou|mandou) um áudio/.test(String(item.texto || '')) && !/dizendo:\]/.test(String(item.texto || ''));
  if (pediuAudio || audioSemTexto) {
    log(`voz: ouvindo o áudio de ${item.de}`);
    const { ouvirAudio } = await import('./comandos.js');
    await ouvirAudio(item.jid, item.de);
  } else {
    log(`voz: lendo a mensagem de ${item.de}`);
    const { textoParaLer } = await import('./avisos.js');
    if (item.canal === 'email' && /\b(inteiro|completo|todo|tudo|integra)\b/.test(p)) {
      const { corpoDoEmail } = await import('./comandos.js');
      await dizer(`${item.assunto ? `Assunto: ${item.assunto}. ` : ''}${corpoDoEmail(item.texto || item.textoOriginal) || textoParaLer(item)}`);
    } else await dizer(textoParaLer(item) + (item.canal === 'email' ? ' Se quiser o texto todo, diga leia o e-mail inteiro.' : ''));
  }
  // depois de ler: ainda dá para pedir "ouça o áudio" (se era áudio) e/ou "responda"
  const ehAudio = /^\[(enviou|mandou) um áudio/.test(String(item.texto || ''));
  if (!podeResponder && !(ehAudio && !pediuAudio)) return;
  let depois = await ouvirTexto({ esperaMs: config.janelaMs, silencioMs: 900, maxMs: 15000 }, ehAudio && !pediuAudio ? 'ouça/responda?' : 'responda?');
  if (depois && ehAudio && !pediuAudio && PEDIU_AUDIO.test(semAcento(depois).toLowerCase())) {
    log(`voz: ouvindo o áudio de ${item.de}`);
    const { ouvirAudio } = await import('./comandos.js');
    await ouvirAudio(item.jid, item.de);
    if (!podeResponder) return;
    depois = await ouvirTexto({ esperaMs: config.janelaMs, silencioMs: 900, maxMs: 15000 }, 'responda?');
  }
  if (depois && PEDIU_LEMBRETE.test(semAcento(depois).toLowerCase())) return lembrarDisso(depois, item, dizer);
  if (depois && PEDIU_ENCAMINHAR.test(semAcento(depois).toLowerCase())) return (await import('./comandos.js')).encaminharFluxo(depois, item);
  if (depois && PEDIU_LINK.test(semAcento(depois).toLowerCase())) {
    const { acharLink, abrirLink } = await import('./avisos.js');
    const url = acharLink(item.texto);
    if (!url) { await dizer('Essa mensagem não tem link.'); return; }
    log(`voz: abrindo o link de ${item.de}: ${url}`);
    await dizer((await abrirLink(url)) ? 'Abrindo o link no navegador.' : 'Não consegui abrir esse link.');
    if (!podeResponder) return;
    depois = await ouvirTexto({ esperaMs: config.janelaMs, silencioMs: 900, maxMs: 15000 }, 'responda?');
  }
  if (podeResponder && depois && PEDIU_RESPOSTA.test(semAcento(depois).toLowerCase())) return talvezResponder(item, { dizer, enviar, pedido: depois });
  if (depois) log(`voz: ouvi "${depois}" (não era "responda", "ouça o áudio" nem "abra o link")`);
}

// ffmpeg: converte a gravação (webm do notebook ou WAV do PC) para outro formato
function converter(entrada, args, saida) {
  return new Promise((ok) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', ...args, saida], { windowsHide: true });
    ff.on('error', () => ok(false)); ff.on('close', (c) => ok(c === 0)); ff.stdin.on('error', () => {}); ff.stdin.end(entrada);
  });
}

/**
 * "Mande um áudio para Fulano": grava a SUA voz e ENVIA DIRETO (pedido dele: sem tocar nem confirmar).
 * O nome do destino é dito antes da gravação; se a gravação for só "cancela"/"deixa pra lá", não envia.
 */
export async function enviarAudioPorVoz(destino, { dizer, enviarAudio }) {
  if (!enviarAudio) { await dizer('O WhatsApp ainda não está conectado.'); return; }
  const para = semEmoji(destino.grupo ? `o grupo ${destino.grupo}` : destino.de);
  await dizer(`Pode falar o áudio para ${para}. Quando terminar, fique em silêncio.`);
  log(`voz: gravando áudio para ${para}…`);
  const r = await ouvir({ esperaMs: 8000, silencioMs: 3000, maxMs: 120000, gravar: true }); // 3 s de pausa encerra (pausa pra pensar não corta); o silêncio do fim é cortado no filtro
  if (!r) { await dizer('Não ouvi nada. Não enviei nada.'); return; }
  if (r.texto !== undefined && !r.gravacao) { await dizer('Atualize a página do notebook, apertando F5, para gravar áudio.'); return; }
  if (r.texto && desistiu(r.texto)) { log(`voz: desistiu do áudio ("${r.texto}")`); await dizer('Tudo bem, não enviei o áudio.'); return; }
  const entrada = r.gravacao || r; // webm do notebook ou WAV do microfone do PC
  const base = path.join(DADOS, 'voz', `recado-${Date.now()}`);
  // Formato que o app do WhatsApp aceita (testado em 23/11): Opus 16 kHz mono, perfil de voz, SEM metadados.
  // (Com 48 kHz e as tags do ffmpeg, o áudio subia mas o celular/PC não conseguia baixar.)
  // Guarda a gravação original da última vez (para diagnóstico, se o áudio não abrir no celular)
  try { fs.writeFileSync(path.join(DADOS, 'voz', r.gravacao ? 'ultima-gravacao.webm' : 'ultima-gravacao.wav'), entrada); } catch {}
  // Em 2 etapas, como no teste que funcionou: 1) WebM do Chrome → WAV puro (o tempo começa do zero, sem as marcas
  // de tempo irregulares do WebM); 2) WAV → OGG no formato que o WhatsApp aceita.
  // Na 1ª etapa também: filtro de ruído (zumbido grave + chiado) e corte do silêncio do começo e do fim
  // (deixa 0,5 s de pausa natural no final). Testado: 7,8 s com ruído → 3,4 s só de fala; chiado de -56 para -74 dB.
  const FILTRO = 'highpass=f=80,afftdn=nf=-25,silenceremove=start_periods=1:start_silence=0.15:start_threshold=-42dB,areverse,silenceremove=start_periods=1:start_silence=0.5:start_threshold=-42dB,areverse';
  const okWav = await converter(entrada, ['-map_metadata', '-1', '-vn', '-af', FILTRO, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav'], base + '-limpo.wav');
  const okOgg = okWav && await converter(fs.readFileSync(base + '-limpo.wav'), ['-map_metadata', '-1', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-frame_duration', '20'], base + '.ogg');
  fs.unlink(base + '-limpo.wav', () => {});
  if (!okOgg) { await dizer('Não consegui preparar o áudio. Não enviei nada.'); return; }
  // duração: lida do próprio OGG pelo ffprobe (se falhar, estima pelo tamanho)
  let seg = 0;
  try {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', base + '.ogg'], { windowsHide: true });
    let out = ''; p.stdout.on('data', (d) => (out += d)); await new Promise((ok) => { p.on('close', ok); p.on('error', ok); });
    seg = Math.round(Number(out.trim()));
  } catch {}
  if (!seg) seg = Math.max(1, Math.round(fs.statSync(base + '.ogg').size / 4000));
  log(`voz: áudio gravado (${seg}s)${r.texto ? `: "${r.texto}"` : ''}`);
  try {
    await enviarAudio(destino.jid, fs.readFileSync(base + '.ogg'), seg);
    log(`ÁUDIO ENVIADO para ${para} (${seg}s)`);
    await dizer(`Áudio enviado para ${para}.`);
  } catch (e) { log(`erro ao enviar áudio para ${para}: ${e.message}`); await dizer('Não consegui enviar o áudio. Ele não foi.'); }
  setTimeout(() => fs.unlink(base + '.ogg', () => {}), 120_000);
}

/** Pergunta em voz alta e devolve o que a pessoa respondeu (texto transcrito, ou '' se ninguém falou). */
export async function perguntar(dizer, pergunta, rotulo = 'pergunta', dica = []) {
  await dizer(pergunta);
  // ditar uma mensagem leva mais tempo e tem pausas no meio: espera mais (igual ao "responda")
  const tempos = rotulo === 'ditado' ? { esperaMs: 8000, silencioMs: 1600, maxMs: 45000 } : { esperaMs: 8000, silencioMs: 1300, maxMs: 15000 };
  return ouvirTexto(tempos, rotulo, dica);
}

/**
 * "Envia mensagem para Fulano": destino = { jid, de, grupo?, privado? }.
 * Se o texto já veio no comando ("... dizendo que chego às 7"), pula a pergunta.
 */
export async function enviarMensagemPorVoz(destino, textoJa, { dizer, enviar }) {
  if (!enviar) { await dizer('O WhatsApp ainda não está conectado.'); return; }
  const para = semEmoji(destino.grupo ? `o grupo ${destino.grupo}` : destino.de);
  let texto = (textoJa || '').trim();
  if (palavras(texto) < 1) {
    texto = await perguntar(dizer, `Qual mensagem para ${para}?`, 'ditado');
    if (!texto) { await dizer(naoOuvi('Cancelei.')); return; }
    if (desistiu(texto)) { log(`voz: desistiu de enviar ("${texto}")`); await dizer('Tudo bem, não vou enviar nada.'); return; }
  }
  return confirmarEEnviar(destino, texto, { dizer, enviar, verbo: 'enviar' });
}

// Lê o texto de volta (ou só mostra na tela, se for contato privado) e só envia com "enviar"/"sim"/"pode".
const semEmoji = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
// ---------- editar antes de enviar ----------
// Na confirmação, além de "pode"/"cancela": "troca sete por oito", "apaga tô indo", "apaga a última frase",
// "acrescenta beijos", "dita de novo", "editar" (explica). Na página, a mensagem fica numa caixa editável.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// acha um trecho no texto ignorando maiúsculas, acentos e pontuação entre as palavras
function acharTrecho(texto, trecho) {
  const pal = semAcento(trecho).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!pal.length) return null;
  // letra a letra (ç → c, é → e…): fica com o MESMO tamanho do original, para recortar no lugar certo
  const base = [...texto.normalize('NFC')].map((ch) => ch.normalize('NFD')[0]).join('').toLowerCase();
  texto = texto.normalize('NFC');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${pal.map(escRe).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'u');
  const m = re.exec(base);
  return m ? { inicio: m.index, fim: m.index + m[0].length } : null;
}
// junta espaços e pontuação que sobraram (mantém a PRIMEIRA: "pode ser?." → "pode ser?")
const limpar = (t) => t.replace(/\s+([,.!?])/g, '$1').replace(/([,.!?])[,.!?]+/g, '$1').replace(/^[,.\s]+/, '').replace(/\s{2,}/g, ' ').trim();
const comPonto = (t) => (/[.!?…]$/.test(t) ? t : t + '.');
const maiuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
/** fala na confirmação → { texto } (editado) | { redigitar } | { ajuda } | { naoAchei } | null (não é edição) */
export function editarPorVoz(texto, fala) {
  const f = fala.trim().replace(/[.!?]+$/, '');
  const s = semAcento(f).toLowerCase();
  if (/^(editar?|edite|mudar?|mude|corrig(e|ir)|altera[r]?|quero (editar|mudar|corrigir|alterar))( (a mensagem|o texto|isso|ela))?$/.test(s)) return { ajuda: true };
  if (/^(dita[r]? de novo|vou (ditar|falar) de novo|fala[r]? de novo|reescreve[r]?|comeca de novo|recomeca[r]?|apaga tudo|de novo)$/.test(s)) return { redigitar: true };
  let m;
  if ((m = /^(?:troca|trocar|troque|muda|mude|mudar|substitui|substitua|corrige|corrija)\s+(.+?)\s+(?:por|pra|para|pelo|pela)\s+(.+)$/i.exec(f))) {
    const a = acharTrecho(texto, m[1]); if (!a) return { naoAchei: m[1] };
    const t0 = texto.normalize('NFC');
    // o trecho trocado começava com maiúscula (início de frase)? a troca também começa
    const novo = /^\p{Lu}/u.test(t0.slice(a.inicio)) ? maiuscula(m[2]) : m[2];
    return { texto: limpar(t0.slice(0, a.inicio) + novo + t0.slice(a.fim)) };
  }
  if (/^(apaga|apague|tira|tire|remove|remova|corta|corte)\s+a\s+ultima\s+frase$/.test(s)) {
    const partes = texto.match(/[^.!?]+[.!?]*/g) || [texto];
    return partes.length > 1 ? { texto: limpar(partes.slice(0, -1).join('')) } : { naoAchei: 'outra frase' };
  }
  if (/^(apaga|apague|tira|tire|remove|remova|corta|corte)\s+a\s+ultima\s+palavra$/.test(s)) {
    return { texto: limpar(texto.replace(/[.!?]+$/, '').replace(/\s*\S+$/, '')) + '.' };
  }
  if ((m = /^(?:apaga|apague|tira|tire|remove|remova|corta|corte)\s+(?:a palavra\s+|o trecho\s+)?(.+)$/i.exec(f))) {
    const a = acharTrecho(texto, m[1]); if (!a) return { naoAchei: m[1] };
    const t0 = texto.normalize('NFC');
    return { texto: maiuscula(limpar(t0.slice(0, a.inicio) + ' ' + t0.slice(a.fim))) };
  }
  if ((m = /^(?:acrescenta|acrescente|adiciona|adicione|coloca|coloque|bota|bote|poe|põe|inclui|inclua)\s+(?:no final\s+|no fim\s+|tamb[eé]m\s+|ainda\s+)?(?:que\s+)?(.+)$/i.exec(f))) {
    return { texto: limpar(`${comPonto(texto.replace(/\s+$/, ''))} ${comPonto(maiuscula(m[1]))}`) };
  }
  return null;
}

async function confirmarEEnviar(item, texto, { dizer, enviar, verbo }) {
  item = { ...item, de: semEmoji(item.de), grupo: item.grupo && semEmoji(item.grupo) };
  // o ditado do Chrome vem sem pontuação: coloca vírgulas, ponto e interrogação antes de ler de volta e enviar
  const pont = await import('./pontuar.js');
  const antes = texto;
  texto = await pont.pontuar(texto);
  if (texto !== antes) log(`voz: pontuado "${texto}"${pont.ultimoErro ? ` (regra simples: ${pont.ultimoErro})` : ''}`);
  const para = item.grupo ? `o grupo ${item.grupo}` : item.de;
  const af = config.saidaVoz !== 'pc' ? await import('./alto-falante.js') : null;
  let rasc = null;
  const fecharRascunho = () => { if (rasc && af) af.esconderRascunho(rasc.id); };
  const enviarAgora = async (t) => {
    fecharRascunho();
    try { await enviar(item.jid, t); log(`ENVIADO para ${para}: ${t}`); await dizer('Enviado.'); }
    catch (e) { log(`erro ao enviar para ${para}: ${e.message}`); await dizer('Não consegui enviar. A mensagem não foi.'); }
  };
  let primeira = true, naoEntendi = 0, falar = true;
  try {
    for (let rodada = 0; rodada < 10; rodada++) {
      // a caixa editável na página (atualiza a cada edição)
      if (af) rasc = af.mostrarRascunho(texto, `Mensagem para ${para}`, rasc?.id);
      let digitado = null;
      rasc?.promessa.then((v) => { digitado = v; });
      if (falar) {
        const pergunta = primeira ? 'Posso enviar, ou quer editar?' : 'Posso enviar?';
        if (item.privado) { notificar(`Mensagem para ${item.de}`, texto); await dizer(`Vou ${verbo} para ${para}. O texto está na tela. ${pergunta}`); }
        else await dizer(`${primeira ? `Vou ${verbo} para ${para}` : 'Ficou assim'}: ${texto}. ${pergunta}`);
      }
      primeira = false; falar = true;
      const bruto = await ouvirTexto({ esperaMs: 7000, silencioMs: 1200, maxMs: 30000 }, 'confirmação');
      // digitou na página? espera terminar (até 3 min) em vez de cancelar por silêncio
      if (!digitado && rasc?.editando()) digitado = await Promise.race([rasc.promessa, new Promise((ok) => setTimeout(() => ok(null), 180_000))]);
      await new Promise((ok) => setTimeout(ok, 50));
      if (digitado?.cancelar) { fecharRascunho(); await dizer('Cancelei. Não enviei nada.'); return; }
      if (digitado?.texto) { log('voz: mensagem editada na página'); return enviarAgora(digitado.texto); }
      const resp = semAcento(bruto).toLowerCase();
      if (bruto) log(`voz: ouvi na confirmação "${bruto}"`);
      if (confirmou(resp)) return enviarAgora(texto);
      if (!resp) { fecharRascunho(); await dizer(falhouTranscricao ? naoOuvi('Cancelei, não enviei nada.') : 'Não ouvi a confirmação. Cancelei, não enviei nada.'); return; }
      if (palavras(resp) <= 5 && CANCELA.test(resp) && !/\b(troca|apaga|tira|acrescenta|muda)\b/.test(resp)) { fecharRascunho(); await dizer('Cancelei. Não enviei nada.'); return; }
      const ed = editarPorVoz(texto, bruto);
      if (ed?.ajuda) { await dizer('Pode dizer: troca uma palavra por outra, apaga um trecho, apaga a última frase, acrescenta alguma coisa, ou dita de novo. Também dá para editar na tela.'); falar = false; continue; }
      if (ed?.naoAchei) { await dizer(`Não achei "${ed.naoAchei}" na mensagem. Fala de novo o que quer mudar.`); falar = false; continue; }
      if (ed?.redigitar) {
        await dizer('Pode falar a mensagem de novo.');
        const novo = await ouvirTexto({ esperaMs: 8000, silencioMs: 1600, maxMs: 45000 }, 'ditado');
        if (!novo) { fecharRascunho(); await dizer(naoOuvi('Cancelei, não enviei nada.')); return; }
        texto = await pont.pontuar(novo); log(`voz: mensagem ditada de novo: "${texto}"`); continue;
      }
      if (ed?.texto) { texto = ed.texto; log(`voz: mensagem editada: "${texto}"`); continue; }
      // frase longa que não é comando de edição: é a mensagem nova inteira
      if (palavras(resp) > 5) { texto = await pont.pontuar(bruto); log(`voz: mensagem trocada: "${texto}"`); continue; }
      if (++naoEntendi > 1) break;
      await dizer('Não entendi. Diga pode para enviar, cancela, ou o que quer mudar.'); falar = false;
    }
    fecharRascunho();
    await dizer('Não entendi. Cancelei, não enviei nada.');
  } catch (e) { fecharRascunho(); throw e; }
}
