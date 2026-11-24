// Comandos de voz ditos no notebook (a página fica ouvindo) e o "bom dia" ao ligar.
//   "até amanhã" → avisa e desliga o PC por completo em 15 s ("cancela" nesse tempo desfaz)
//   "responda"   → responde a última mensagem de WhatsApp (dos últimos 15 min)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';
import { log, dizer, naFila, notificar, ultimoAvisoWhatsApp, enviarPeloWhatsApp } from './avisos.js';

const TESTE = process.env.VIGIA_TESTE_DESLIGAR === '1'; // ensaio: não desliga de verdade
let desligando = false;

// Roda o shutdown.exe e devolve se o Windows aceitou (antes era "atira e esquece": um erro passava em silêncio).
function shutdown(args) {
  if (TESTE) { log(`(ENSAIO) shutdown ${args.join(' ')}`); return Promise.resolve(true); }
  return new Promise((ok) => {
    const p = spawn('shutdown.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; p.stdout.on('data', (d) => (err += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { log(`shutdown ${args.join(' ')}: ${e.message}`); ok(false); });
    p.on('close', (c) => { if (c) log(`shutdown ${args.join(' ')} recusado (código ${c}): ${err.trim().slice(0, 160)}`); ok(c === 0); });
  });
}

async function ateAmanha() {
  if (desligando) return;
  desligando = true;
  log('comando: até amanhã → desligando o PC em 15 s');
  // fala por cima da fila (é um comando direto) e agenda o desligamento.
  // Sem "/hybrid" o desligamento já é completo (sem inicialização rápida). Atenção: "/full" NÃO existe e fazia o Windows recusar.
  await dizer('Até amanhã! Desligando o PC em 15 segundos. Se quiser cancelar, diga cancela.');
  const ok = await shutdown(['/s', '/f', '/t', '15', '/c', 'Vigia: até amanhã! Desligando o PC.']);
  if (!ok) { desligando = false; await dizer('Não consegui desligar o PC. Desligue pelo menu Iniciar.'); return; }
  notificar('🌙 Até amanhã', 'O PC desliga em 15 segundos. Diga "cancela" para desfazer.', true);
  setTimeout(() => { desligando = false; }, 60_000); // se por algum motivo não desligar, libera um novo "até amanhã"
}

// "Cancelar" (em qualquer frase): para o que estiver falando/ouvindo/gravando, descarta a fila e,
// se o PC estiver para desligar, desfaz o desligamento.
async function cancelar() {
  const { cancelarTudo } = await import('./avisos.js');
  await cancelarTudo();
  conversaAtiva = false;
  if (desligando) {
    desligando = false;
    await shutdown(['/a']);
    log('comando: cancela → desligamento cancelado');
    return naFila(() => dizer('Cancelado. O PC continua ligado.'));
  }
  return naFila(() => dizer('Cancelado.'));
}

// Uma conversa de responder/enviar por vez: cliques repetidos ou "responda" em sequência não enfileiram várias.
let conversaAtiva = false;
async function umaConversa(nome, fn) {
  if (conversaAtiva) { log(`comando ${nome} ignorado: já existe uma conversa em andamento`); return; }
  conversaAtiva = true;
  try { await fn(); } finally { conversaAtiva = false; }
}

async function responder(textoOuvido) {
  return umaConversa('responda', async () => {
    const item = ultimoAvisoWhatsApp();
    if (!item) { await naFila(() => dizer('Não tem mensagem recente para responder.')); return; }
    const { talvezResponder } = await import('./conversa.js');
    await naFila(() => talvezResponder(item, { dizer, enviar: enviarPeloWhatsApp(), pedido: textoOuvido }));
  });
}

// "Envia mensagem para o Dênisson" (opcional: "... dizendo que chego às sete")
const tirarAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const limparNome = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').trim();
// Acha o contato/grupo pelo nome falado (pelo som; pergunta "para quem?" e "qual deles?" se precisar).
// → destino { jid, de, grupo?, privado } ou null (já avisou por voz que cancelou)
async function escolherDestino(nome) {
  const { buscarDestino, nomesConhecidos } = await import('./whatsapp.js');
  const { perguntar } = await import('./conversa.js');
  const nomes = nomesConhecidos();
  // "para mim" / "pra mim mesmo": o seu próprio número (conversa "Você"), bom para testar
  if (/^(mim|mim mesmo|eu|eu mesmo|meu numero|meu número|meu zap)$/i.test(String(nome || '').trim())) {
    const { jidProprio } = await import('./whatsapp.js');
    if (jidProprio()) return { jid: jidProprio(), de: 'você', privado: false };
  }
  if (!nome) nome = await perguntar(dizer, 'Para quem?', 'contato', nomes);
  if (!nome) { await dizer('Não ouvi o nome. Cancelei.'); return null; }
  let r = buscarDestino(nome);
  if (r.tipo === 'nenhum') {
    nome = await perguntar(dizer, `Não achei ${nome}. Fala só o nome do contato.`, 'contato', nomes);
    r = nome ? buscarDestino(nome) : r;
  }
  if (r.tipo === 'nenhum') { await dizer('Não achei esse contato. Cancelei, não enviei nada.'); return null; }
  let destino = r.destino;
  if (r.tipo === 'varios') {
    const ord = ['primeiro', 'segundo', 'terceiro', 'quarto'];
    const lista = r.opcoes.map((o, i) => `${ord[i]}, ${limparNome(o.de)}`).join('; ');
    const resp = tirarAcento(await perguntar(dizer, `Encontrei: ${lista}. Qual deles?`, 'escolha', r.opcoes.map((o) => o.de)));
    let i = ord.findIndex((o) => resp.includes(o));
    if (i < 0) i = [/\b(um|1)\b/, /\b(dois|2)\b/, /\b(tres|3)\b/, /\b(quatro|4)\b/].findIndex((re) => re.test(resp));
    if (i < 0 && resp) { const r2 = buscarDestino(resp); if (r2.tipo === 'ok') i = r.opcoes.findIndex((o) => o.jid === r2.destino.jid); }
    if (i < 0 || !r.opcoes[i]) { await dizer('Não entendi qual. Cancelei, não enviei nada.'); return null; }
    destino = r.opcoes[i];
  }
  return { ...destino, privado: !destino.grupo && config.privados.some((p) => tirarAcento(destino.de).includes(tirarAcento(p))) };
}
const nomeDoComando = (s) => s.replace(/^(o|a)\s+/i, '').replace(/[.,!?]+$/, '').trim();

async function enviarPara(t) {
  const { enviarMensagemPorVoz } = await import('./conversa.js');
  let resto = (/mensage\w*\s+(?:para|pra|pro|pr[oa]s?|ao|à|a)\s+(.+)$/i.exec(t) || [])[1] || '';
  let texto = '';
  const d = /\s*,?\s+(?:dizendo|falando|avisando|perguntando)\s+(.+)$/i.exec(resto);
  if (d) { texto = d[1].replace(/^que\s+/i, ''); resto = resto.slice(0, d.index); }
  const nome = nomeDoComando(resto);
  await naFila(async () => {
    const destino = await escolherDestino(nome);
    if (!destino) return;
    log(`enviar por voz: destino ${destino.de}${destino.grupo ? ' (grupo)' : ''}`);
    await enviarMensagemPorVoz(destino, texto, { dizer, enviar: enviarPeloWhatsApp() });
  });
}

// "Mande um áudio para o Dênisson": grava a sua voz e envia como áudio do WhatsApp (com conferência antes)
async function enviarAudioPara(t) {
  const { enviarAudioPorVoz } = await import('./conversa.js');
  const { enviarAudioPeloWhatsApp } = await import('./avisos.js');
  const nome = nomeDoComando((/[aá]udio\w*\s+(?:para|pra|pro|pr[oa]s?|ao|à|a)\s+(.+)$/i.exec(t) || [])[1] || '');
  await naFila(async () => {
    const destino = await escolherDestino(nome);
    if (!destino) return;
    log(`áudio por voz: destino ${destino.de}${destino.grupo ? ' (grupo)' : ''}`);
    await enviarAudioPorVoz(destino, { dizer, enviarAudio: enviarAudioPeloWhatsApp() });
  });
}

// "Ouça o áudio": TOCA o áudio original da pessoa. Se não conseguir tocar, lê a transcrição.
export async function ouvirAudio(jid, nome, audioJa) {
  const { ultimoAudio } = await import('./whatsapp.js');
  const a = audioJa || ultimoAudio(jid) || (jid ? null : ultimoAudio());
  if (!a) return dizer('Não achei áudio recente para ouvir.');
  const quem = nome ? ` de ${nome}` : '';
  const arq = path.join(DADOS, 'voz', `audio-${Date.now()}.wav`);
  const ok = await new Promise((res) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-ac', '1', '-ar', '24000', arq], { windowsHide: true });
    ff.on('error', () => res(false)); ff.on('close', (c) => res(c === 0)); ff.stdin.on('error', () => {}); ff.stdin.end(a.buf);
  });
  if (ok) {
    log(`ouvir áudio: tocando o original${quem} (${a.seg}s)`);
    const { tocarArquivo } = await import('./avisos.js');
    await tocarArquivo(arq);
    setTimeout(() => fs.unlink(arq, () => {}), 120_000);
    return;
  }
  // não deu para tocar: lê a transcrição
  let texto = a.texto;
  if (!texto) {
    try { const { transcrever } = await import('./transcrever.js'); texto = await transcrever(a.buf, [], a.tipo); a.texto = texto || ''; }
    catch (e) { log(`ouvir áudio: transcrição falhou (${e.message})`); }
  }
  if (texto) return dizer(`Não consegui tocar o áudio${quem}. Ele diz: "${texto}"`);
  return dizer('Não consegui tocar nem transcrever esse áudio agora.');
}
const ehAudioSemTexto = (item) => /^\[(enviou|mandou) um áudio/.test(String(item?.texto || '')) && !/dizendo:\]/.test(String(item?.texto || ''));

// "Leia" dito a qualquer momento: lê a última mensagem/e-mail avisado (até 30 min)
async function lerUltima() {
  const { ultimoAviso, textoParaLer } = await import('./avisos.js');
  const item = ultimoAviso();
  if (!item) return naFila(() => dizer('Não tem mensagem recente para ler.'));
  if (ehAudioSemTexto(item)) return naFila(() => ouvirAudio(item.jid, item.de)); // áudio que não deu para transcrever
  const de = item.grupo ? `${item.de}, no grupo ${item.grupo}` : item.de;
  return naFila(() => dizer(`${item.canal === 'email' ? 'E-mail de' : 'Mensagem de'} ${de}. ${textoParaLer(item)}`));
}

// ---------- comandos com o NOME da pessoa ----------
// "leia a última mensagem do Ana", "ouça o último áudio da Carla", "responda o Diego com áudio"
const HIST = path.join(DADOS, 'historico.jsonl');
const VERBOS = /^\W*(pode\s+)?(leia|le|ler|ouca|ouve|ouvir|escuta|escute|escutar|toca|toque|tocar|reproduz\w*|responda|responde|responder)\b/;
const POR_AUDIO = /\b(com|por|em|via|mandando|num|no)\s+(um\s+)?audio\b/;
/** Tira do comando falado o verbo, "a última mensagem", "com áudio"… e devolve { nome, porAudio }. */
export function entenderPedido(t) {
  let s = tirarAcento(t).replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const porAudio = POR_AUDIO.test(s);
  s = s.replace(VERBOS, '')
    .replace(/\b(com|por|em|via|mandando|num|no)\s+(um\s+)?(audio|texto|mensagem|escrito)\b.*$/, '')
    .replace(/^\s*(pra mim\s+)?((a|o|as|os)\s+)?(ultim[ao]s?\s+)?(mensage\w*|msg|audios?|recados?|zap)?\s*/, '')
    .replace(/^(que\s+)?(d[oa]s?|de|pro|pra|para|ao|a|o)\s+/, '')
    .replace(/\s+(mandou|enviou|me mandou|me enviou)\b.*$/, '')
    .trim();
  return { nome: nomeDoComando(s), porAudio };
}

// A conversa do contato/grupo pelo nome falado (sem perguntar nada se não achar) → destino ou null
async function acharConversa(nome) {
  if (!nome) return null;
  const { buscarDestino, idsDoContato } = await import('./whatsapp.js');
  const r = buscarDestino(nome);
  const destino = r.tipo === 'ok' ? r.destino : r.tipo === 'varios' ? r.opcoes[0] : null;
  if (!destino) return null;
  return { ...destino, ids: destino.grupo ? [destino.jid] : idsDoContato(destino.jid) };
}

// Última mensagem dessa conversa no histórico (o que o Vigia avisou), até 7 dias
function ultimaDoHistorico(ids) {
  let linhas = [];
  try {
    const fd = fs.openSync(HIST, 'r'); const tam = fs.fstatSync(fd).size; const ler = Math.min(tam, 3_000_000);
    const buf = Buffer.alloc(ler); fs.readSync(fd, buf, 0, ler, tam - ler); fs.closeSync(fd);
    linhas = buf.toString('utf8').split('\n');
  } catch { return null; }
  const limite = Date.now() - 7 * 86_400_000;
  for (let i = linhas.length - 1; i >= 0; i--) {
    let x; try { x = JSON.parse(linhas[i]); } catch { continue; }
    if (x.canal !== 'whatsapp' || !x.jid || Date.parse(x.quando) < limite) continue;
    if (ids.includes(x.jid)) return x;
  }
  return null;
}

async function lerUltimaDe(t) {
  const { nome } = entenderPedido(t);
  if (!nome) return lerUltima();
  const c = await acharConversa(nome);
  if (!c) return naFila(() => dizer(`Não achei ${nome} nos seus contatos.`));
  const quem = limparNome(c.de);
  const item = ultimaDoHistorico(c.ids);
  if (!item) return naFila(() => dizer(`Não tenho mensagem recente ${c.grupo ? 'do grupo' : 'de'} ${quem}.`));
  log(`voz: lendo a última mensagem de ${quem}`);
  const { textoParaLer } = await import('./avisos.js');
  const hora = new Date(item.quando).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (ehAudioSemTexto(item)) {
    const { ultimoAudioDe } = await import('./whatsapp.js');
    return naFila(() => ouvirAudio(null, quem, ultimoAudioDe(c.ids)));
  }
  return naFila(() => dizer(`${c.grupo ? `No grupo ${quem}` : `Última mensagem de ${quem}`}, às ${hora}. ${textoParaLer(item)}`));
}

async function ouvirAudioDe(t) {
  const { nome } = entenderPedido(t);
  const c = await acharConversa(nome);
  if (!c) return naFila(() => dizer(nome ? `Não achei ${nome} nos seus contatos.` : 'De quem é o áudio?'));
  const { ultimoAudioDe } = await import('./whatsapp.js');
  const a = ultimoAudioDe(c.ids);
  const quem = limparNome(c.de);
  if (!a) return naFila(() => dizer(`Não tenho áudio recente ${c.grupo ? 'do grupo' : 'de'} ${quem}.`));
  log(`voz: tocando o último áudio de ${quem}`);
  return naFila(() => ouvirAudio(null, quem, a));
}

// "Responda o Ana" (texto ditado) / "responda o Ana com áudio" (grava sua voz). Sem nome: a última avisada.
async function responderPara(t) {
  const { nome, porAudio } = entenderPedido(t);
  let destino = null;
  if (nome) {
    destino = await escolherDestino(nome);
    if (!destino) return;
  } else {
    const item = ultimoAvisoWhatsApp();
    if (!item) return naFila(() => dizer('Não tem mensagem recente para responder.'));
    destino = { jid: item.jid, de: item.grupo || item.de, grupo: item.grupo, privado: item.privado };
  }
  log(`responder por voz: ${destino.de}${porAudio ? ' (áudio)' : ''}`);
  if (porAudio) {
    const { enviarAudioPorVoz } = await import('./conversa.js');
    const { enviarAudioPeloWhatsApp } = await import('./avisos.js');
    return naFila(() => enviarAudioPorVoz(destino, { dizer, enviarAudio: enviarAudioPeloWhatsApp() }));
  }
  const { enviarMensagemPorVoz } = await import('./conversa.js');
  return naFila(() => enviarMensagemPorVoz(destino, '', { dizer, enviar: enviarPeloWhatsApp() }));
}

// ---------- respostas rápidas ----------
// "Que horas são?"
function horaFalada(d = new Date()) {
  const h = d.getHours(), m = d.getMinutes();
  const hs = h === 0 ? 'meia-noite' : h === 12 ? 'meio-dia' : h === 1 || h === 13 ? 'uma hora' : `${h} horas`;
  const ms = m === 0 ? '' : m === 30 ? ' e meia' : ` e ${m}${m === 1 ? ' minuto' : ''}`;
  return `${h === 0 || h === 12 || h === 1 || h === 13 ? 'É' : 'São'} ${hs}${ms}.`;
}
async function dizerHora() {
  const hoje = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  return naFila(() => dizer(`${horaFalada()} Hoje é ${hoje}.`));
}

// "Vai chover hoje?" / "Como está o tempo?"
async function dizerClima() {
  const { previsaoHoje, temperaturaAgora } = await import('./clima.js');
  const [prev, agora] = await Promise.all([previsaoHoje(), temperaturaAgora()]);
  if (!prev && agora == null) return naFila(() => dizer('Não consegui ver a previsão agora. Tenta de novo daqui a pouco.'));
  return naFila(() => dizer(`${agora != null ? `Agora está fazendo ${agora} graus. ` : ''}${prev}`));
}

// "Lê meus e-mails de hoje": os e-mails de pessoas que chegaram hoje (sem propaganda/newsletter)
async function lerEmailsHoje() {
  const inicio = new Date(); inicio.setHours(0, 0, 0, 0);
  let linhas = [];
  try {
    const fd = fs.openSync(HIST, 'r'); const tam = fs.fstatSync(fd).size; const ler = Math.min(tam, 3_000_000);
    const buf = Buffer.alloc(ler); fs.readSync(fd, buf, 0, ler, tam - ler); fs.closeSync(fd);
    linhas = buf.toString('utf8').split('\n');
  } catch {}
  const emails = [];
  for (const l of linhas) {
    let x; try { x = JSON.parse(l); } catch { continue; }
    if (x.canal !== 'email' || Date.parse(x.quando) < inicio.getTime()) continue;
    if (['silencio', 'baixa'].includes(x.prioridade)) continue;
    emails.push(x);
  }
  if (!emails.length) return naFila(() => dizer('Hoje não chegou nenhum e-mail de pessoas, só propaganda ou nada.'));
  const mostrar = emails.slice(-6);
  const partes = mostrar.map((e) => {
    const hora = new Date(e.quando).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `Às ${hora}, de ${limparNome(e.de)}: ${e.resumo || e.assunto || 'sem assunto'}`;
  });
  const total = emails.length === 1 ? 'Hoje chegou 1 e-mail.' : `Hoje chegaram ${emails.length} e-mails.`;
  const extra = emails.length > mostrar.length ? ` Esses são os ${mostrar.length} mais recentes.` : '';
  log(`voz: lendo os e-mails de hoje (${emails.length})`);
  return naFila(() => dizer(`${total}${extra} ${partes.join('. ')}.`));
}

// "Abra o link" (o último link que chegou) / "abra o link do Ana" / "abre o link que a Bia mandou"
function nomeDoLink(t) {
  const s = tirarAcento(t).replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^\W*(pode\s+)?(abra|abre|abrir|abri)\s+(o\s+|os\s+)?(ultimo\s+)?links?\s*/, '')
    .replace(/^que\s+/, '')
    .replace(/^(d[oa]s?|de)\s+/, '')
    .replace(/^(o|a)\s+/, '')
    .replace(/\s+(mandou|enviou|me mandou|me enviou|passou)\b.*$/, '')
    .trim();
  return nomeDoComando(s);
}
// o item mais recente do histórico com link (de uma conversa, ou de qualquer uma), até 7 dias
function ultimoLinkDoHistorico(ids, acharLink) {
  let linhas = [];
  try {
    const fd = fs.openSync(HIST, 'r'); const tam = fs.fstatSync(fd).size; const ler = Math.min(tam, 3_000_000);
    const buf = Buffer.alloc(ler); fs.readSync(fd, buf, 0, ler, tam - ler); fs.closeSync(fd);
    linhas = buf.toString('utf8').split('\n');
  } catch { return null; }
  const limite = Date.now() - 7 * 86_400_000;
  for (let i = linhas.length - 1; i >= 0; i--) {
    let x; try { x = JSON.parse(linhas[i]); } catch { continue; }
    if (x.canal !== 'whatsapp' || Date.parse(x.quando) < limite) continue;
    if (ids && !ids.includes(x.jid)) continue;
    if (!ids && x.prioridade === 'baixa') continue; // sem nome: ignora grupo de promoção (Lobão)
    const url = acharLink(x.texto);
    if (url) return { url, de: x.grupo ? `${limparNome(x.de)}, no grupo ${limparNome(x.grupo)}` : limparNome(x.de) };
  }
  return null;
}
async function abrirUltimoLink(t) {
  const { acharLink, abrirLink, ultimoAviso } = await import('./avisos.js');
  const nome = nomeDoLink(t);
  let achado = null;
  if (nome) {
    const c = await acharConversa(nome);
    if (!c) return naFila(() => dizer(`Não achei ${nome} nos seus contatos.`));
    achado = ultimoLinkDoHistorico(c.ids, acharLink);
    if (!achado) return naFila(() => dizer(`Não achei link recente ${c.grupo ? 'no grupo' : 'de'} ${limparNome(c.de)}.`));
  } else {
    const item = ultimoAviso();
    const url = item && acharLink(item.texto);
    achado = url ? { url, de: item.de } : ultimoLinkDoHistorico(null, acharLink);
    if (!achado) return naFila(() => dizer('Não achei nenhum link recente.'));
  }
  log(`voz: abrindo o link de ${achado.de}: ${achado.url}`);
  const ok = await abrirLink(achado.url);
  return naFila(() => dizer(ok ? `Abrindo o link de ${achado.de}.` : 'Não consegui abrir esse link.'));
}

// "Silencia o Ana (por duas horas / o dia todo)" e "volta a avisar o Ana"
const NUMEROS = { uma: 1, um: 1, duas: 2, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, oito: 8, dez: 10, quinze: 15, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50 };
export function entenderSilencio(t) {
  let s = tirarAcento(t).replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  let minutos = 60;
  const fimDoDia = () => { const d = new Date(); d.setHours(23, 59, 0, 0); return Math.max(1, Math.round((d - Date.now()) / 60000)); };
  let m;
  if ((m = /\b(?:por\s+)?(?:o\s+)?(dia (todo|inteiro)|hoje|ate (o fim do dia|amanha|de noite))\b.*$/.exec(s))) { minutos = fimDoDia(); s = s.slice(0, m.index); }
  else if ((m = /\b(?:por\s+)?meia hora\b.*$/.exec(s))) { minutos = 30; s = s.slice(0, m.index); }
  else if ((m = /\b(?:por\s+)?(\d+|uma|um|duas|dois|tres|quatro|cinco|seis|oito|dez)\s+horas?\b.*$/.exec(s))) { minutos = 60 * (Number(m[1]) || NUMEROS[m[1]]); s = s.slice(0, m.index); }
  else if ((m = /\b(?:por\s+)?(\d+|dez|quinze|vinte|trinta|quarenta|cinquenta)\s+min\w*\b.*$/.exec(s))) { minutos = Number(m[1]) || NUMEROS[m[1]]; s = s.slice(0, m.index); }
  const nome = s
    .replace(/^\W*(pode\s+)?(silencia|silencie|silenciar|pausa|pause|pausar|muta|mute|mutar|cala|desliga)\s+/, '')
    .replace(/^\W*(pode\s+)?(volta|voltar|volte)\s+a\s+(avisar|falar)\s+/, '').replace(/^\W*(pode\s+)?(avisar|avisa)\s+(de novo\s+)?/, '')
    .replace(/^\W*(tira|tirar|tire)\s+o\s+silencio\s+/, '').replace(/^\W*(dessilencia|dessilenciar|desmuta|desmutar)\s+/, '')
    .replace(/^(os\s+avisos|as\s+mensagens|o\s+aviso)\s+/, '').replace(/^(d[oa]s?|de)\s+/, '').replace(/^(o|a)\s+/, '')
    .replace(/\s+(de novo|por enquanto|um pouco|ai)$/, '').trim();
  return { nome: nomeDoComando(nome), minutos: Math.min(minutos, 24 * 60) };
}
function duracaoFalada(min) {
  if (min >= 12 * 60) return 'até o fim do dia';
  if (min % 60 === 0) return `por ${min === 60 ? 'uma hora' : `${min / 60} horas`}`;
  return min === 30 ? 'por meia hora' : `por ${min} minutos`;
}
async function silenciarPessoa(t) {
  const { nome, minutos } = entenderSilencio(t);
  if (!nome) return naFila(() => dizer('Quem você quer silenciar? Fala, por exemplo: silencia o Ana.'));
  const c = await acharConversa(nome);
  if (!c) return naFila(() => dizer(`Não achei ${nome} nos seus contatos.`));
  const { silenciar } = await import('./avisos.js');
  silenciar(c.ids, c.de, minutos);
  const quem = limparNome(c.de);
  log(`voz: silenciando ${quem} ${duracaoFalada(minutos)}`);
  return naFila(() => dizer(`Combinado. ${c.grupo ? 'O grupo ' : ''}${quem} fica em silêncio ${duracaoFalada(minutos)}. As mensagens aparecem só na tela.`));
}
async function voltarAvisar(t) {
  const { nome } = entenderSilencio(t);
  const c = await acharConversa(nome);
  if (!c) return naFila(() => dizer(nome ? `Não achei ${nome} nos seus contatos.` : 'Quem você quer voltar a ouvir?'));
  const { dessilenciar } = await import('./avisos.js');
  const qtd = dessilenciar(c.ids);
  const quem = limparNome(c.de);
  if (qtd === null) return naFila(() => dizer(`${quem} não estava em silêncio.`));
  log(`voz: voltando a avisar ${quem} (${qtd} mensagens no silêncio)`);
  return naFila(() => dizer(`Pronto, volto a avisar ${quem}.${qtd ? ` Nesse tempo, chegaram ${qtd === 1 ? 'uma mensagem' : `${qtd} mensagens`}. Diga leia a última mensagem de ${quem} para ouvir.` : ''}`));
}

// ---------- encaminhar ----------
// "encaminha essa mensagem para o Ana" (depois do aviso / do "leia"), "encaminha a última mensagem do Bruno para o Ana".
// Reenvia o ORIGINAL com o selo "Encaminhada" do WhatsApp (texto, áudio, foto, documento), só depois do seu "pode".
export function entenderEncaminhar(t) {
  const s = tirarAcento(t).replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const p = /\b(para|pra|pro|pros|pras)\s+(.+)$/.exec(s);
  const para = p ? nomeDoComando(p[2].replace(/^(o|a|os|as)\s+/, '')) : '';
  const antes = p ? s.slice(0, p.index) : s;
  const o = /\b(?:mensage\w*|audio|foto|video|arquivo|documento)\s+d[oa]s?\s+(.+)$/.exec(antes);
  const de = o && !/^(essa|esse|esta|este)\b/.test(o[1]) ? nomeDoComando(o[1].replace(/^(o|a)\s+/, '')) : '';
  return { de, para };
}
/** O fluxo inteiro (já dentro da fila de voz). itemDoAviso = a mensagem do aviso, quando vem da janela "leia/responda". */
export async function encaminharFluxo(t, itemDoAviso) {
  const { encaminharPeloWhatsApp, ultimoAviso } = await import('./avisos.js');
  const { mensagensOriginais } = await import('./whatsapp.js');
  const { perguntar, confirmou } = await import('./conversa.js');
  const encaminhar = encaminharPeloWhatsApp();
  if (!encaminhar) return dizer('O WhatsApp ainda não está conectado.');
  const { de, para } = entenderEncaminhar(t);
  let item = itemDoAviso;
  if (de) {
    const c = await acharConversa(de);
    if (!c) return dizer(`Não achei ${de} nos seus contatos.`);
    item = ultimaDoHistorico(c.ids);
  }
  if (!item) item = ultimoAviso();
  if (!item || item.canal !== 'whatsapp') return dizer('Não tenho mensagem de WhatsApp recente para encaminhar.');
  const originais = mensagensOriginais(item.msgIds);
  if (!originais.length) return dizer('Não tenho mais o original dessa mensagem, então não consigo encaminhar. Só as que chegaram depois da última atualização do Vigia.');
  const destino = await escolherDestino(para);
  if (!destino) return;
  const quem = limparNome(item.grupo ? `${item.de}, do grupo ${item.grupo}` : item.de);
  const praQuem = limparNome(destino.grupo ? `o grupo ${destino.de}` : destino.de);
  const n = originais.length;
  const resp = await perguntar(dizer, `Encaminho ${n > 1 ? `as ${n} mensagens` : 'a mensagem'} de ${quem} para ${praQuem}?`, 'confirmação');
  if (!confirmou(resp)) { log(`encaminhar: desistiu ("${resp}")`); return dizer('Tudo bem, não encaminhei.'); }
  try {
    await encaminhar(destino.jid, originais);
    log(`ENCAMINHADO para ${praQuem}: ${n} mensagem(ns) de ${quem}`);
    return dizer(`Encaminhado para ${praQuem}.`);
  } catch (e) { log(`encaminhar: falhou (${e.message})`); return dizer('Não consegui encaminhar agora. Tenta de novo daqui a pouco.'); }
}

// "Fala pro Aninha responder logo" → manda "Responde logo." (com a confirmação e a edição de sempre)
async function darRecado(t) {
  const r = await import('./recado.js');
  const e = r.entenderRecado(t);
  if (!e) return dizer('Não entendi para quem é o recado. Fala, por exemplo: fala pro Ana responder logo.');
  // o nome pode ter várias palavras ("grupo Gato Cachorro e Elefante"): escolhe o pedaço que bate com um contato
  const { tamanhoDoNome } = await import('./whatsapp.js');
  const n = tamanhoDoNome(e.partes) || e.qtdNome;
  const { nome, recado } = r.separar(e.partes, n);
  if (!recado) return dizer('Qual é o recado?');
  const destino = await escolherDestino(nome);
  if (!destino) return;
  const texto = await r.converterRecado(recado, limparNome(destino.de));
  log(`recado para ${destino.de}: "${recado}" → "${texto}"`);
  const { enviarMensagemPorVoz } = await import('./conversa.js');
  return enviarMensagemPorVoz(destino, texto, { dizer, enviar: enviarPeloWhatsApp() });
}

// "O que o Ana falou sobre o carro?": procura nas mensagens dos últimos 7 dias e responde falando
async function perguntarAoHistorico(t) {
  const { perguntarHistorico } = await import('./historico.js');
  const r = await perguntarHistorico(t);
  log(`voz: pergunta ao histórico "${t}"${r.nomes?.length ? ` (${r.nomes.join(', ')})` : ''} → ${r.resposta}`);
  return naFila(() => dizer(r.resposta));
}

// "Repete": fala de novo a última coisa que o Vigia disse
async function repetir() {
  const { ultimaFala } = await import('./avisos.js');
  const t = ultimaFala();
  return naFila(() => dizer(t || 'Não tenho nada para repetir.'));
}

// "Me lembra às três de ligar pro cliente"
async function novoLembrete(t) {
  const frase = await criarLembreteFalado(t);
  await naFila(() => dizer(frase));
}

// "me lembra DISSO às três" / "me lembra de responder isso daqui a uma hora": o lembrete leva a mensagem junto
const REFERENCIA = /\b(disso|isso|dessa mensagem|desta mensagem|essa mensagem|desse e-?mail|esse e-?mail|desse audio|desse áudio|esse audio|esse áudio)\b/i;
/** Cria o lembrete e devolve a frase de confirmação. item = a mensagem a que "disso" se refere (padrão: o último aviso). */
export async function criarLembreteFalado(t, item) {
  const { criarLembrete, quandoFalado } = await import('./lembretes.js');
  let ajustar, sobre = '';
  if (REFERENCIA.test(tirarAcento(t))) {
    if (!item) { const { ultimoAviso } = await import('./avisos.js'); item = ultimoAviso(); }
    if (!item) return 'Não tenho mensagem recente para lembrar. Fala o assunto, por exemplo: me lembra às três de ligar pro cliente.';
    const de = limparNome(item.grupo ? `${item.de}, no grupo ${item.grupo}` : item.de);
    sobre = `${item.canal === 'email' ? 'o e-mail' : 'a mensagem'} de ${de}`;
    const conteudo = String(item.resumo || item.texto || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    ajustar = (txt) => {
      const resto = txt.replace(new RegExp(REFERENCIA.source, 'gi'), '').replace(/\s+/g, ' ').replace(/\b(de|da|do)\s*$/i, '').trim();
      return `${resto ? resto + ' ' : ''}${sobre}${conteudo ? ': ' + conteudo : ''}`;
    };
  }
  const r = await criarLembrete(t, ajustar);
  if (r.ok) {
    const quando = quandoFalado(r.lembrete.quando);
    if (sobre) return `Combinado. ${quando}, eu te lembro d${sobre.startsWith('o ') ? 'o' : 'a'} ${sobre.slice(2)}.`;
    return r.lembrete.texto === 'lembrete' ? `Combinado. ${quando}, eu te lembro.` : `Combinado. ${quando}, eu te lembro de ${r.lembrete.texto}.`;
  }
  if (r.motivo === 'passado') return 'Esse horário já passou. Fala de novo com outro horário.';
  if (r.motivo === 'sem-hora') return 'Não entendi o horário. Fala, por exemplo: me lembra disso às três, ou daqui a meia hora.';
  return 'Não consegui criar o lembrete agora. Tenta de novo daqui a pouco.';
}

export function iniciarComandos(af) {
  // dispara os lembretes na hora marcada: voz (mesmo no horário de silêncio), notificação e cartão na página
  import('./lembretes.js').then(({ iniciarLembretes }) => iniciarLembretes((l, atrasado) => {
    const nome = config.saudacaoNome ? config.saudacaoNome.replace(/^Sr\.?\s*/i, 'senhor ') + ', ' : '';
    notificar(`⏰ Lembrete${atrasado ? ' (atrasado)' : ''}`, l.texto, true);
    af.mostrarAviso({ canal: 'lembrete', de: '⏰ Lembrete', resumo: l.texto, urgente: true, hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) });
    const sobre = l.texto === 'lembrete' ? `são ${new Date(l.quando).getHours()} horas` : l.texto; // lembrete sem assunto
    naFila(() => dizer(`${nome}lembrete${atrasado ? ' atrasado, era para ' + new Date(l.quando).getHours() + ' horas' : ''}: ${sobre}.`));
  }));
  af.aoComando(async (c, t) => {
    // segunda trava (caso a página seja antiga): desligar/cancelar só com frase curta; o botão manda "(botão)"
    const curta = t.includes('(botão)') || t.trim().split(/\s+/).filter(Boolean).length <= 4;
    if (c === 'ate-amanha' && !curta) { log(`comando ignorado (frase longa demais): "${t}"`); return; }
    // "até amanhã" só vale como a frase inteira (segunda trava, igual à da página)
    const tn = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (c === 'ate-amanha' && !t.includes('(botão)') && !/^\W*((tchau|valeu|boa noite|ok)\W+)?ate amanha(\W+(vigia|jarvis))?\W*$/.test(tn)) {
      log(`comando ignorado ("até amanhã" no meio de outra frase): "${t}"`); return;
    }
    if (c === 'enviar' && config.responderVoz) return umaConversa('enviar', () => enviarPara(t));
    if (c === 'enviar-audio' && config.responderVoz) return umaConversa('enviar-audio', () => enviarAudioPara(t));
    if (c === 'lembrete') return novoLembrete(t);
    if (c === 'leia') return lerUltima();
    if (c === 'leia-de') return lerUltimaDe(t);
    if (c === 'hora') return dizerHora();
    if (c === 'clima') return dizerClima();
    if (c === 'emails') return lerEmailsHoje();
    if (c === 'repete') return repetir();
    if (c === 'abrir-link') return abrirUltimoLink(t);
    if (c === 'perguntar') return perguntarAoHistorico(t);
    if (c === 'recado' && config.responderVoz) return umaConversa('recado', () => naFila(() => darRecado(t)));
    if (c === 'encaminhar' && config.responderVoz) return umaConversa('encaminhar', () => naFila(() => encaminharFluxo(t)));
    if (c === 'silenciar') return silenciarPessoa(t);
    if (c === 'dessilenciar') return voltarAvisar(t);
    if (c === 'ouca-de') return ouvirAudioDe(t);
    if (c === 'responda-de' && config.responderVoz) return umaConversa('responda-de', () => responderPara(t));
    if (c === 'ouca-audio') {
      // áudio da última mensagem avisada (se foi áudio); senão, o último áudio recebido de qualquer conversa
      const { ultimoAviso } = await import('./avisos.js');
      const { ultimoAudio } = await import('./whatsapp.js');
      const item = ultimoAviso();
      const doAviso = item?.jid && ultimoAudio(item.jid);
      return naFila(() => ouvirAudio(doAviso ? item.jid : null, doAviso ? item.de : null));
    }
    if (c === 'ate-amanha') return ateAmanha();
    if (c === 'cancela') return cancelar();
    if (c === 'responda' && config.responderVoz) return responder(t);
  });

  // Bom dia: na primeira vez do dia em que o notebook conecta na página (assim você ouve)
  const ARQ = path.join(DADOS, 'ultima-saudacao.txt');
  af.aoConectar(async () => {
    const hoje = new Date().toLocaleDateString('pt-BR');
    let ultima = '';
    try { ultima = fs.readFileSync(ARQ, 'utf8').trim(); } catch {}
    if (ultima === hoje) return;
    fs.writeFileSync(ARQ, hoje);
    const h = new Date().getHours();
    const oi = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    const data = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    log(`saudação: ${oi}`);
    await new Promise((r) => setTimeout(r, 4000)); // dá tempo de o e-mail ler o que chegou com o PC desligado
    const { previsaoHoje } = await import('./clima.js');
    const { whatsSemResposta } = await import('./pendencias.js');
    const juntar = (l) => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}`);
    const unicos = (l) => [...new Set(l.map(limparNome).filter(Boolean))];

    const clima = await previsaoHoje();
    const zap = unicos(whatsSemResposta(30).map((p) => p.nome));
    // Só WhatsApp: e-mail nem sempre precisa de resposta, então não vira pendência.
    const pend = zap.length
      ? ` No WhatsApp, ${zap.length === 1 ? 'ficou sem resposta' : 'ficaram sem resposta'}: ${juntar(zap.slice(0, 4))}${zap.length > 4 ? ` e mais ${zap.length - 4}` : ''}.`
      : ' Nenhuma conversa esperando resposta no WhatsApp.';
    // "Sr." escrito por extenso para a voz ler "senhor"
    const nome = config.saudacaoNome ? `, ${config.saudacaoNome.replace(/^Sr\.?\s*/i, 'senhor ')}` : '';
    const frase = `${oi}${nome}! Hoje é ${data}.${clima ? ' ' + clima : ''}${pend}`;
    log(`saudação: ${frase}`);
    await naFila(() => dizer(frase));
  });
}
