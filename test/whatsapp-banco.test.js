// Testes do banco de mensagens e das ferramentas de consulta (dados fictícios, banco em memória).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BancoWhatsApp, isoSP, lerDataEntrada, variantesTelefone } from '../src/whatsapp-banco.js';
import { criarFerramentasWhatsApp } from '../src/ferramentas-whatsapp.js';

const PN = '553100000001@s.whatsapp.net', LID = '999000111@lid', OUTRO = '553100000002@s.whatsapp.net', GRUPO = '120000000000000001@g.us';
const T0 = Math.floor(Date.parse('2026-11-20T12:00:00Z') / 1000);
let n = 0;
const msg = ({ jid, alt, fromMe = false, texto, ts, participant, extra = {}, push = 'Fornecedor Exemplo' }) => ({
  key: { id: 'ID' + (++n), remoteJid: jid, remoteJidAlt: alt, fromMe, participant }, pushName: fromMe ? undefined : push,
  messageTimestamp: ts, message: texto !== undefined ? { conversation: texto } : extra,
});

function montar() {
  n = 0;
  const b = new BancoWhatsApp(':memory:', { pnDoLid: (l) => (l === '999000111' ? '553100000001' : null), lidDoPn: (p) => (p === '553100000001' ? '999000111' : null) });
  b.gravarContato({ jid: PN, notify: 'Comércio Exemplo Indústria', verifiedName: 'Comércio Exemplo Indústria' });
  b.gravarContato({ jid: OUTRO, name: 'Outra Pessoa' });
  b.gravarConversa({ id: GRUPO, tipo: 'grupo', nome: 'Grupo de Cotações', participantes: 5 });
  b.gravarConversa({ id: OUTRO, arquivada: true });
  const lista = [
    msg({ jid: LID, texto: 'Bom dia', ts: T0 }),
    msg({ jid: LID, texto: 'Envie a cotação no email compras@exemplo.com.br', ts: T0 + 60 }),
    msg({ jid: PN, fromMe: true, texto: 'Certo, vou enviar a solicitação', ts: T0 + 120 }),
    msg({ jid: PN, ts: T0 + 180, extra: { documentMessage: { fileName: 'Proposta Técnica.pdf', mimetype: 'application/pdf', fileLength: 2048, mediaKey: Buffer.from('k'), directPath: '/x', caption: 'segue a proposta' } } }),
    msg({ jid: GRUPO, participant: PN, texto: 'Alguém tem preço de rolamento?', ts: T0 + 240, push: 'Fornecedor no grupo' }),
    msg({ jid: OUTRO, texto: 'Mensagem numa conversa arquivada', ts: T0 + 300, push: 'Outra' }),
    msg({ jid: PN, ts: T0 + 360, extra: { extendedTextMessage: { text: 'Respondendo', contextInfo: { stanzaId: 'ID2', participant: PN, quotedMessage: { conversation: 'Envie a cotação' }, isForwarded: true } } } }),
    msg({ jid: PN, ts: T0 + 420, extra: { audioMessage: { seconds: 12, ptt: true, mimetype: 'audio/ogg; codecs=opus', mediaKey: Buffer.from('k'), directPath: '/a' } } }),
    msg({ jid: PN, ts: T0 + 480, extra: { viewOnceMessage: { message: { imageMessage: { caption: 'segredo', mimetype: 'image/jpeg', mediaKey: Buffer.from('k'), directPath: '/v' } } } } }),
    msg({ jid: PN, ts: T0 + 500, extra: { reactionMessage: { text: '👍' } } }), // reação: não é mensagem
  ];
  for (const m of lista) b.gravarMensagem(m, 'ao_vivo');
  return b;
}
const ferramentas = (b, status = { situacao: 'conectado' }) => Object.fromEntries(criarFerramentasWhatsApp({ banco: () => b, status: () => status }).map((f) => [f.name, f]));

test('grava sem duplicar e junta LID com telefone', () => {
  const b = montar();
  assert.equal(b.cobertura(null).total_no_banco, 9);
  assert.equal(b.gravarMensagem(msg({ jid: LID, texto: 'Bom dia', ts: T0 }), 'ao_vivo'), 'nova'); // id novo
  const repetida = { key: { id: 'ID1', remoteJid: LID, fromMe: false }, messageTimestamp: T0, message: { conversation: 'Bom dia' } };
  assert.equal(b.gravarMensagem(repetida, 'historico_whatsapp'), 'existente');
  const r = b.consultar({ conversas: [PN], limite: 50, ordem: 'antigas' });
  assert.ok(r.linhas.every((l) => l.conversa === PN));
});

test('consulta por nome parcial sem acento, telefone em vários formatos, enviadas e recebidas', async () => {
  const F = ferramentas(montar());
  const a = await F.consultar_mensagens_whatsapp.run({ contato: 'comercio exemplo' });
  assert.equal(a.situacao, 'ok');
  assert.ok(a.mensagens.some((m) => m.direcao === 'enviada') && a.mensagens.some((m) => m.direcao === 'recebida'));
  assert.ok(a.mensagens.some((m) => m.tipo_conversa === 'grupo')); // a mesma pessoa falando no grupo
  for (const t of ['+55 31 0000-0001', '(31) 0000-0001', '3100000001', '5531 00000001']) {
    const r = await F.consultar_mensagens_whatsapp.run({ telefone: t, grupos: 'excluir' });
    assert.equal(r.total, 7, t);
  }
  const env = await F.consultar_mensagens_whatsapp.run({ telefone: '3100000001', direcao: 'enviadas' });
  assert.deepEqual(env.mensagens.map((m) => m.conteudo), ['Certo, vou enviar a solicitação']);
  assert.equal(env.mensagens[0].remetente.nome, 'Você (dono deste WhatsApp)');
});

test('palavra-chave sem acento e maiúscula, curta e no nome do arquivo', async () => {
  const F = ferramentas(montar());
  assert.equal((await F.buscar_mensagens_whatsapp.run({ palavra_chave: 'COTACAO' })).total, 1);
  assert.equal((await F.buscar_mensagens_whatsapp.run({ palavra_chave: 'proposta tecnica' })).total, 1);
  assert.equal((await F.buscar_mensagens_whatsapp.run({ palavra_chave: 'bo' })).total, 1);
  assert.equal((await F.buscar_mensagens_whatsapp.run({ palavra_chave: 'enviar cotação', todas_as_palavras: true })).total, 0);
  assert.equal((await F.buscar_mensagens_whatsapp.run({ palavra_chave: 'vou solicitação', todas_as_palavras: true })).total, 1);
});

test('período, tipo, anexos, citação, encaminhada e visualização única', async () => {
  const F = ferramentas(montar());
  const p = await F.consultar_mensagens_whatsapp.run({ data_inicial: isoSP(T0 + 60), data_final: isoSP(T0 + 180) });
  assert.equal(p.total, 3);
  const docs = await F.consultar_anexos_whatsapp.run({ tipo_anexo: 'pdf' });
  assert.equal(docs.anexos.length, 1);
  assert.equal(docs.anexos[0].nome, 'Proposta Técnica.pdf');
  const aud = await F.consultar_mensagens_whatsapp.run({ tipo: 'audio' });
  assert.equal(aud.mensagens[0].anexos[0].segundos, 12);
  const resp = (await F.consultar_mensagens_whatsapp.run({ palavra_chave: 'respondendo' })).mensagens[0];
  assert.equal(resp.resposta_a.id_mensagem, 'ID2');
  assert.equal(resp.encaminhada, true);
  const unica = (await F.consultar_mensagens_whatsapp.run({ tipo: 'imagem' })).mensagens[0];
  assert.match(unica.conteudo, /visualização única/);
  assert.ok(!JSON.stringify(unica).includes('segredo'));
});

test('paginação por cursor sem repetir nem pular', async () => {
  const F = ferramentas(montar());
  const vistos = [];
  let cursor;
  do {
    const r = await F.consultar_mensagens_whatsapp.run({ limite: 2, ...(cursor ? { cursor } : {}) });
    vistos.push(...r.mensagens.map((m) => m.id_mensagem));
    cursor = r.cursor;
    assert.equal(r.has_more, !!cursor);
  } while (cursor);
  assert.equal(vistos.length, 9);
  assert.equal(new Set(vistos).size, 9);
  await assert.rejects(F.consultar_mensagens_whatsapp.run({ contato: 'outra', cursor: Buffer.from('{"h":"x"}').toString('base64url') }));
});

test('ordem cronológica = últimas N em ordem de leitura', async () => {
  const F = ferramentas(montar());
  const r = await F.consultar_historico_conversa.run({ telefone: '3100000001', limite: 3 });
  const horas = r.mensagens.map((m) => m.data_hora);
  assert.deepEqual([...horas].sort(), horas);
  assert.equal(r.mensagens.at(-1).data_hora, isoSP(T0 + 480));
});

test('arquivadas, grupos e listas', async () => {
  const F = ferramentas(montar());
  assert.equal((await F.consultar_mensagens_whatsapp.run({ arquivadas: 'somente' })).total, 1);
  assert.equal((await F.consultar_mensagens_whatsapp.run({ arquivadas: 'excluir', contato: 'outra pessoa' })).total, 0);
  const g = await F.listar_grupos_whatsapp.run({});
  assert.equal(g.grupos[0].nome, 'Grupo de Cotações');
  assert.equal(g.grupos[0].participantes, 5);
  const c = await F.listar_conversas_whatsapp.run({ tipo: 'individual' });
  assert.ok(c.conversas.find((x) => x.id_conversa === OUTRO).arquivada);
  const ct = await F.listar_contatos_whatsapp.run({ telefone: '31 0000-0001' });
  assert.equal(ct.contatos[0].telefone, '+553100000001');
});

test('situações: contato inexistente, não sincronizado, falha de conexão', async () => {
  const b = montar();
  b.gravarContato({ jid: '553100000009@s.whatsapp.net', name: 'Sem Mensagens Ltda' });
  const F = ferramentas(b);
  assert.equal((await F.consultar_mensagens_whatsapp.run({ contato: 'ninguem com esse nome' })).situacao, 'contato_nao_encontrado');
  assert.equal((await F.consultar_mensagens_whatsapp.run({ contato: 'sem mensagens' })).situacao, 'nao_sincronizado');
  assert.equal((await F.consultar_mensagens_whatsapp.run({ palavra_chave: 'xyz inexistente' })).situacao, 'sem_mensagens');
  const off = ferramentas(b, { situacao: 'reconectando', desde: '2026-11-20T09:00:00-03:00' });
  const r = await off.consultar_mensagens_whatsapp.run({ palavra_chave: 'xyz inexistente' });
  assert.equal(r.situacao, 'falha_conexao');
  assert.ok((await off.consultar_mensagens_whatsapp.run({})).avisos.some((a) => a.startsWith('falha_conexao')));
  assert.equal((await F.consultar_mensagens_whatsapp.run({})).historico_incompleto, true);
});

test('edição e apagar para todos não removem a mensagem', () => {
  const b = montar();
  b.processarProtocolo({ key: { id: 'P1', remoteJid: PN, fromMe: false }, message: { protocolMessage: { type: 14, key: { id: 'ID2' }, editedMessage: { conversation: 'Texto editado' } } } });
  b.processarProtocolo({ key: { id: 'P2', remoteJid: PN, fromMe: false }, message: { protocolMessage: { type: 0, key: { id: 'ID1' } } } });
  const r = b.consultar({ conversas: [PN], limite: 50, ordem: 'antigas' }).linhas;
  assert.equal(r.find((l) => l.msg_id === 'ID2').texto, 'Texto editado');
  assert.equal(r.find((l) => l.msg_id === 'ID1').apagada, 1);
  assert.equal(b.cobertura(null).total_no_banco, 9);
});

test('migração do histórico de avisos não duplica o que já existe', () => {
  const b = montar();
  const quando = new Date((T0 + 900) * 1000).toISOString();
  const itens = [{ canal: 'whatsapp', quando, de: 'Comércio Exemplo Indústria', texto: 'Bom dia\nLinha só do aviso' }];
  const r = b.migrarHistoricoAvisos(itens);
  assert.equal(r.novas, 1);
  assert.equal(b.migrarHistoricoAvisos(itens).novas, 0);
  const leg = b.consultar({ conversas: [PN], limite: 50, ordem: 'antigas' }).linhas.filter((l) => l.origem === 'aviso_legado');
  assert.deepEqual(leg.map((l) => l.texto), ['Linha só do aviso']);
  assert.equal(leg[0].horario_aproximado, 1);
});

test('datas em America/Sao_Paulo e telefones', () => {
  assert.equal(isoSP(T0), '2026-11-20T09:00:00-03:00');
  assert.equal(lerDataEntrada('2026-11-20'), Date.parse('2026-11-20T03:00:00Z') / 1000);
  assert.equal(lerDataEntrada('2026-11-20', true), Date.parse('2026-11-21T02:59:59Z') / 1000);
  assert.equal(lerDataEntrada('2026-11-20 08:30'), Date.parse('2026-11-20T11:30:00Z') / 1000);
  assert.throws(() => lerDataEntrada('ontem'));
  assert.deepEqual(variantesTelefone('+55 (31) 98888-7777').sort(), ['553188887777', '5531988887777']);
  assert.deepEqual(variantesTelefone('123'), []);
});

test('ferramentas são somente leitura e sem parâmetros obrigatórios desnecessários', () => {
  const lista = criarFerramentasWhatsApp({ banco: () => null, status: () => ({}) });
  assert.deepEqual(lista.map((f) => f.name).sort(), ['buscar_mensagens_whatsapp', 'consultar_anexos_whatsapp', 'consultar_historico_conversa',
    'consultar_mensagens_whatsapp', 'listar_contatos_whatsapp', 'listar_conversas_whatsapp', 'listar_grupos_whatsapp', 'obter_anexo_whatsapp',
    'sincronizar_historico_whatsapp', 'verificar_status_whatsapp']);
  for (const f of lista) {
    assert.equal(f.annotations.readOnlyHint, true, f.name);
    assert.ok((f.inputSchema.required || []).length <= 1, f.name);
  }
  assert.equal(lista.find((f) => f.name === 'consultar_mensagens_whatsapp').inputSchema.required, undefined);
});
