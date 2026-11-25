// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito: veja o arquivo NOTICE)
// Envio de e-mail (pedido pelo ChatGPT): SMTP do mesmo provedor do IMAP, com anexos. Depois de enviar, guarda uma
// cópia na pasta "Enviados" (por IMAP), para aparecer no Outlook/webmail como se você tivesse enviado.
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapFlow } from 'imapflow';
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
  const smtp = nodemailer.createTransport({
    host: config.email.smtpHost, port: config.email.smtpPorta, secure: config.email.smtpPorta === 465,
    auth: { user: config.email.usuario, pass: config.email.senha },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  });
  await smtp.sendMail(msg);
  copiarParaEnviados(msg).catch((e) => log(`e-mail: enviado, mas não consegui guardar nos Enviados (${e.message})`));
  return { para: paraL, cc: ccL };
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
