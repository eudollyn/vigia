// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito: veja o arquivo NOTICE)
// Envio de e-mail (pedido pelo ChatGPT): SMTP do mesmo provedor do IMAP, com anexos. Depois de enviar, guarda uma
// cópia na pasta "Enviados" (por IMAP), para aparecer no Outlook/webmail como se você tivesse enviado.
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import { config, emailAtivo } from './config.js';
import { log } from './avisos.js';

const EMAIL_OK = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
const lista = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;,]/)).map((s) => String(s).trim()).filter(Boolean);

/** { para, cc?, assunto, mensagem, arquivos:[{caminho,nome,tipo}] } → { para, cc } */
export async function enviarEmail({ para, cc, assunto, mensagem, arquivos = [] }) {
  if (!emailAtivo()) throw new Error('O e-mail não está configurado no Vigia (EMAIL_USUARIO e EMAIL_SENHA).');
  const paraL = lista(para), ccL = lista(cc);
  const ruins = [...paraL, ...ccL].filter((x) => !EMAIL_OK.test(x));
  if (!paraL.length) throw new Error('Falta o endereço de e-mail do destinatário.');
  if (ruins.length) throw new Error(`Endereço de e-mail inválido: ${ruins.join(', ')}`);
  if (!String(assunto || '').trim()) throw new Error('Falta o assunto do e-mail.');

  const de = config.email.nomeRemetente ? { name: config.email.nomeRemetente, address: config.email.usuario } : config.email.usuario;
  const msg = {
    from: de, to: paraL, cc: ccL.length ? ccL : undefined, subject: String(assunto).trim(),
    text: String(mensagem || ''),
    attachments: arquivos.map((a) => ({ filename: a.nome, content: fs.readFileSync(a.caminho), contentType: a.tipo })),
  };
  const smtp = criarSmtp();
  await smtp.sendMail(msg);
  copiarParaEnviados(msg).catch((e) => log(`e-mail: enviado, mas não consegui guardar nos Enviados (${e.message})`));
  return { para: paraL, cc: ccL };
}

function criarSmtp() {
  return nodemailer.createTransport({
    host: config.email.smtpHost, port: config.email.smtpPorta, secure: config.email.smtpPorta === 465,
    auth: { user: config.email.usuario, pass: config.email.senha },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  });
}

// ---------- resposta no mesmo fio ----------
const semColchetes = (id) => String(id || '').trim().replace(/^<|>$/g, '').trim();
const comColchetes = (id) => `<${semColchetes(id)}>`;
const idsDe = (v) => [].concat(v || []).flatMap((x) => String(x).match(/<[^<>\s]+>/g) || []);

/** Busca na Caixa de Entrada (só leitura) o e-mail cujo Message-ID é `id`. Devolve o e-mail lido pelo mailparser. */
export async function buscarOriginal(id) {
  const alvo = semColchetes(id);
  if (!alvo || /[\s<>"]/.test(alvo) || !alvo.includes('@')) throw new Error('id_original inválido: informe o Message-ID do e-mail recebido (ex.: <abc123@exemplo.com.br>). Nada foi enviado.');
  const imap = new ImapFlow({
    host: config.email.host, port: config.email.porta, secure: config.email.porta === 993, logger: false,
    auth: { user: config.email.usuario, pass: config.email.senha },
  });
  await imap.connect();
  try {
    await imap.mailboxOpen('INBOX', { readOnly: true });
    const uids = await imap.search({ header: { 'message-id': alvo } }, { uid: true }) || [];
    const achados = [];
    for (const uid of uids.slice(0, 5)) {
      const m = await imap.fetchOne(String(uid), { source: true }, { uid: true });
      if (m?.source) achados.push(await simpleParser(m.source));
    }
    // a busca do IMAP é por trecho: confere o Message-ID exato
    const exatos = achados.filter((m) => semColchetes(m.messageId).toLowerCase() === alvo.toLowerCase());
    if (!exatos.length) throw new Error(`Não achei na Caixa de Entrada o e-mail com Message-ID <${alvo}>. Nada foi enviado.`);
    if (exatos.length > 1) throw new Error(`Há ${exatos.length} e-mails com o Message-ID <${alvo}>; não dá para saber qual responder. Nada foi enviado.`);
    return exatos[0];
  } finally { await imap.logout().catch(() => {}); }
}

/** e-mail original (mailparser) → destinatários e cabeçalhos da resposta. Erro se faltar o Message-ID. */
export function montarResposta(original) {
  const messageId = semColchetes(original?.messageId);
  if (!messageId) throw new Error('O e-mail original não tem Message-ID; não dá para responder no mesmo fio. Nada foi enviado.');
  const enderecos = (campo) => (campo?.value || []).map((x) => x.address).filter((a) => a && EMAIL_OK.test(a));
  const para = enderecos(original.replyTo).length ? enderecos(original.replyTo) : enderecos(original.from);
  if (!para.length) throw new Error('O e-mail original não tem Reply-To nem From válido. Nada foi enviado.');
  const assuntoOrig = String(original.subject || '').trim();
  const assunto = /^re\s*:/i.test(assuntoOrig) ? assuntoOrig : `Re: ${assuntoOrig}`.trim();
  const references = [...new Set([...idsDe(original.references), comColchetes(messageId)])];
  return { para, assunto, inReplyTo: comColchetes(messageId), references };
}

/**
 * Responde no mesmo fio. Só envia se achar o original com segurança. Se o SMTP aceitar e só a cópia nos Enviados falhar,
 * não reenvia: devolve sucesso com `aviso`. `dep` existe para os testes (SMTP/IMAP falsos).
 */
export async function responderEmail({ idOriginal, mensagem }, dep = {}) {
  if (!emailAtivo()) throw new Error('O e-mail não está configurado no Vigia (EMAIL_USUARIO e EMAIL_SENHA).');
  if (!String(idOriginal || '').trim()) throw new Error('Falta o id_original (Message-ID do e-mail a responder). Nada foi enviado.');
  if (!String(mensagem || '').trim()) throw new Error('Mensagem vazia. Nada foi enviado.');
  const { buscar = buscarOriginal, smtp = criarSmtp(), enviados = copiarParaEnviados, registrar = log } = dep;
  const r = montarResposta(await buscar(idOriginal));
  const de = config.email.nomeRemetente ? { name: config.email.nomeRemetente, address: config.email.usuario } : config.email.usuario;
  const msg = { from: de, to: r.para, subject: r.assunto, text: String(mensagem), inReplyTo: r.inReplyTo, references: r.references };
  const info = await smtp.sendMail(msg);
  let aviso;
  try { await enviados(msg); } catch (e) {
    aviso = `E-mail enviado, mas não consegui guardar a cópia nos Enviados (${e.message}). Não reenvie.`;
    registrar(`e-mail: resposta enviada, mas não consegui guardar nos Enviados (${e.message})`);
  }
  return { para: r.para, assunto: r.assunto, inReplyTo: r.inReplyTo, references: r.references, info, ...(aviso ? { aviso } : {}) };
}

async function copiarParaEnviados(msg) {
  const bruto = await new MailComposer({ ...msg, date: new Date() }).compile().build();
  const imap = new ImapFlow({
    host: config.email.host, port: config.email.porta, secure: true, logger: false,
    auth: { user: config.email.usuario, pass: config.email.senha },
  });
  await imap.connect();
  try {
    const pastas = await imap.list();
    const enviados = pastas.find((p) => p.specialUse === '\\Sent')
      || pastas.find((p) => /^(inbox[./])?(sent|enviad|itens enviados|sent items)/i.test(p.path));
    if (!enviados) throw new Error('pasta Enviados não encontrada');
    await imap.append(enviados.path, bruto, ['\\Seen']);
  } finally { await imap.logout().catch(() => {}); }
}
