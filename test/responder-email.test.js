// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026
// responder_email: cabeçalhos da resposta (In-Reply-To, References, destinatário e assunto), sem envio real:
// o original vem de um IMAP falso e o SMTP é o streamTransport do nodemailer (só monta a mensagem).
import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

process.env.EMAIL_USUARIO = 'vigia@exemplo.com.br';
process.env.EMAIL_SENHA = 'senha-ficticia';
const { responderEmail, montarResposta, montarCopiaEnviados } = await import('../src/enviar-email.js');

const original = (cab) => simpleParser([...cab, 'Content-Type: text/plain; charset=utf-8', '', 'Pode mandar a cotação?'].join('\r\n'));
const smtpFalso = () => nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' });

async function responder(cab, dep = {}) {
  const smtp = smtpFalso();
  let copia = null;
  const r = await responderEmail({ idOriginal: '<orig-3@fornecedor.com.br>', mensagem: 'Segue a cotação.' }, {
    buscar: async () => original(cab), smtp, enviados: async (msg) => { copia = msg; }, registrar: () => {}, ...dep,
  });
  return { r, enviado: r.info?.message ? await simpleParser(r.info.message) : null, copia };
}

test('resposta usa Reply-To, In-Reply-To, References encadeadas e assunto com Re:', async () => {
  const { r, enviado, copia } = await responder([
    'From: Fornecedor <vendas@fornecedor.com.br>', 'Reply-To: Cotações <cotacoes@fornecedor.com.br>',
    'To: vigia@exemplo.com.br', 'Subject: Cotação de rolamentos', 'Message-ID: <orig-3@fornecedor.com.br>',
    'References: <orig-1@fornecedor.com.br> <orig-2@exemplo.com.br>', 'In-Reply-To: <orig-2@exemplo.com.br>',
  ]);
  assert.equal(r.aviso, undefined);
  assert.deepEqual(enviado.to.value.map((x) => x.address), ['cotacoes@fornecedor.com.br']);
  assert.equal(enviado.subject, 'Re: Cotação de rolamentos');
  assert.equal(enviado.inReplyTo, '<orig-3@fornecedor.com.br>');
  assert.deepEqual([].concat(enviado.references), ['<orig-1@fornecedor.com.br>', '<orig-2@exemplo.com.br>', '<orig-3@fornecedor.com.br>']);
  assert.match(enviado.text, /Segue a cotação\./);
  assert.equal(copia.inReplyTo, '<orig-3@fornecedor.com.br>'); // a cópia dos Enviados leva os mesmos cabeçalhos
});

test('sem Reply-To responde ao From; não duplica "Re:"; sem References começa a cadeia pelo Message-ID', async () => {
  const { enviado } = await responder([
    'From: Fornecedor <vendas@fornecedor.com.br>', 'Subject: RE: Cotação', 'Message-ID: <orig-3@fornecedor.com.br>',
  ]);
  assert.deepEqual(enviado.to.value.map((x) => x.address), ['vendas@fornecedor.com.br']);
  assert.equal(enviado.subject, 'RE: Cotação');
  assert.deepEqual([].concat(enviado.references), ['<orig-3@fornecedor.com.br>']);
});

test('original sem Message-ID ou não encontrado: erro e nada é enviado', async () => {
  let chamadas = 0;
  const smtp = { sendMail: async () => { chamadas++; } };
  await assert.rejects(responder(['From: a@fornecedor.com.br', 'Subject: X'], { smtp }), /não tem Message-ID/);
  await assert.rejects(responder([], { smtp, buscar: async () => { throw new Error('Não achei na Caixa de Entrada'); } }), /Não achei/);
  await assert.rejects(responderEmail({ idOriginal: '', mensagem: 'oi' }, { smtp }), /Falta o id_original/);
  assert.equal(chamadas, 0);
  assert.throws(() => montarResposta({ subject: 'x', from: { value: [{ address: 'a@b.com' }] } }), /Message-ID/);
});

test('SMTP aceita e só os Enviados falham: sucesso com aviso, sem reenviar', async () => {
  let envios = 0;
  const smtp = smtpFalso();
  const enviar = smtp.sendMail.bind(smtp);
  smtp.sendMail = (m) => { envios++; return enviar(m); };
  const { r } = await responder(['From: vendas@fornecedor.com.br', 'Subject: Oi', 'Message-ID: <orig-3@fornecedor.com.br>'],
    { smtp, enviados: async () => { throw new Error('IMAP fora do ar'); } });
  assert.equal(envios, 1);
  assert.match(r.aviso, /Enviados.*IMAP fora do ar.*Não reenvie/);
});

test('um Message-ID só por resposta: o mesmo no SMTP e na cópia dos Enviados', async () => {
  const cab = ['From: Fornecedor <vendas@fornecedor.com.br>', 'Subject: Cotação', 'Message-ID: <orig-3@fornecedor.com.br>'];
  const responderUma = async () => {
    let bruto = null;
    const { r, enviado } = await responder(cab, { enviados: async (msg) => { bruto = await montarCopiaEnviados(msg); } });
    return { r, enviado, copia: await simpleParser(bruto) };
  };
  const a = await responderUma();
  assert.match(a.enviado.messageId, /^<[0-9a-f-]{36}@exemplo\.com\.br>$/);
  assert.equal(a.copia.messageId, a.enviado.messageId);
  assert.equal(a.r.messageId, a.enviado.messageId);
  assert.equal(a.enviado.inReplyTo, '<orig-3@fornecedor.com.br>');
  assert.equal(a.copia.inReplyTo, '<orig-3@fornecedor.com.br>');
  assert.equal(a.copia.date.getTime(), a.enviado.date.getTime());
  const b = await responderUma();
  assert.notEqual(b.enviado.messageId, a.enviado.messageId); // cada resposta tem o seu
});
