// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { test } from 'node:test';
import { consultarRecebidas, validarConsulta } from '../src/consulta-whatsapp.js';

const jid = '111@s.whatsapp.net';
const lid = '222@lid';
const grupo = '333@g.us';
const arquivado = '444@s.whatsapp.net';
const data = '2026-11-25T09:00:00-03:00';
const segundos = Date.parse(data) / 1000;
const criar = (id, chat, message, opcoes = {}) => ({
  key: { id, remoteJid: chat, remoteJidAlt: chat === lid ? jid : undefined, fromMe: false },
  messageTimestamp: segundos, message, ...opcoes,
});
const simples = (id, texto, messageTimestamp = segundos) =>
  criar(id, jid, { conversation: texto }, { messageTimestamp });
const registros = [
  simples('antiga', 'Recebi a ficha técnica.', segundos - 1),
  criar('legenda', lid, { documentWithCaptionMessage: { message: { documentMessage: { caption: 'Cotação em anexo.', mediaKey: [123], url: 'privada' } } } }),
  simples('recente', 'Pode enviar a cotação por e-mail?', segundos + 1),
  criar('grupo', grupo, { conversation: 'Cotação do grupo.' }),
  criar('arquivo', arquivado, { conversation: 'Cotação arquivada.' }),
  criar('minha', jid, { conversation: 'Cotação enviada.' }, { key: { id: 'minha', remoteJid: jid, fromMe: true } }),
  criar('unica', jid, { viewOnceMessageV2: { message: { imageMessage: { caption: 'Cotação secreta.' } } } }),
  criar('temporaria', jid, { ephemeralMessage: { message: { conversation: 'Cotação temporária.' } } }),
  criar('expiracao', jid, { extendedTextMessage: { text: 'Cotação temporária.', contextInfo: { expiration: 86400 } } }),
  criar('duracao', jid, { conversation: 'Cotação temporária.' }, { ephemeralDuration: 86400 }),
  criar('audio', jid, { audioMessage: { seconds: 12 } }),
];
const cache = { porChat: {}, msgs: {} };
for (const msg of registros) {
  (cache.porChat[msg.key.remoteJid] ||= []).push(msg.key.id);
  cache.msgs[msg.key.id] = JSON.stringify(msg);
}
cache.porChat[jid].push('recente', 'corrompida', 'removida', 'legenda');
cache.msgs.corrompida = '{';
const consultar = (filtros, dados = cache) => consultarRecebidas(dados, validarConsulta(filtros), {
  decodificar: JSON.parse,
  idsDoContato: (id) => id === lid ? [lid, jid] : [id],
  estaArquivada: (ids) => ids.includes(arquivado),
  nomesDoContato: (id) => id === jid ? ['Érica Suprimentos'] : [],
});

test('combina nome, palavra-chave e período inclusivo com fuso', () => {
  assert.deepEqual(consultar({ contato: 'erica', palavra_chave: 'COTACAO', desde: data, ate: data }), {
    ha_mais: false,
    mensagens: [{ contato: 'Érica Suprimentos', recebido_em: '2026-11-25T12:00:00.000Z', texto: 'Cotação em anexo.' }],
  });
});

test('aceita cada filtro isolado, ordena, limita e não altera o cache', () => {
  const antes = structuredClone(cache);
  const busca = consultar({ palavra_chave: 'cotação', limite: 1 });
  assert.equal(busca.ha_mais, true);
  assert.deepEqual(busca.mensagens.map((x) => x.texto), ['Pode enviar a cotação por e-mail?']);
  assert.equal(consultar({ palavra_chave: 'cotação' }).mensagens.length, 2);
  assert.equal(consultar({ contato: 'Érica' }).mensagens.length, 3);
  assert.equal(consultar({ desde: data }).mensagens.length, 2);
  assert.deepEqual(consultar({ contato: 'Inexistente' }), { mensagens: [], ha_mais: false });
  assert.deepEqual(cache, antes);
});

test('limita o texto e usa o nome de perfil de um contato sem cadastro', () => {
  const msg = { ...simples('longa', 'x'.repeat(2100)), pushName: 'Nome de perfil' };
  const resultados = consultar({ contato: 'nome de perfil' }, {
    porChat: { [jid]: ['longa'] }, msgs: { longa: JSON.stringify(msg) },
  }).mensagens;
  assert.equal(resultados[0].texto.length, 2000);
  assert.equal(resultados[0].texto_truncado, true);
});

test('rejeita filtros inválidos sem repetir dados informados', () => {
  for (const filtros of [
    null, [], {}, { limite: 1 }, { contato: '   ' }, { contato: 1 }, { palavra_chave: 'x'.repeat(201) },
    { desde: '2026-11-25' }, { ate: '2026-02-30T00:00:00Z' },
    { desde: data, ate: '2026-11-25T11:59:59Z' }, { desde: data, limite: 31 },
    { desde: data, limite: 1.5 }, { desde: data, arquivo: 'segredo' },
  ]) {
    assert.throws(() => validarConsulta(filtros));
  }
});

async function iniciarMcp(t, habilitar, whatsapp = true) {
  const raiz = await mkdtemp(path.join(tmpdir(), 'vigia-mcp-'));
  let filho;
  t.after(async () => {
    if (filho && filho.exitCode === null && filho.signalCode === null) {
      const parou = once(filho, 'exit');
      filho.kill();
      await parou;
    }
    await rm(raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const src = path.join(raiz, 'src');
  await mkdir(src);
  await writeFile(path.join(raiz, 'package.json'), '{"type":"module"}');
  for (const nome of ['conector-gpt.js', 'consulta-whatsapp.js', 'config.js']) {
    await cp(new URL(`../src/${nome}`, import.meta.url), path.join(src, nome));
  }
  await writeFile(path.join(src, 'avisos.js'), 'export const log = console.log, dizer = () => {}, naFila = async () => {}, notificar = () => {};');
  await writeFile(path.join(src, 'whatsapp.js'), `
    import { consultarRecebidas } from './consulta-whatsapp.js';
    const cache = ${JSON.stringify(cache)};
    export const consultarMensagensWhatsApp = (filtros) => consultarRecebidas(cache, filtros, {
      decodificar: JSON.parse, idsDoContato: (id) => [id], estaArquivada: () => false, nomesDoContato: () => []
    });
  `);
  const portaLivre = createServer();
  portaLivre.listen(0, '127.0.0.1');
  await once(portaLivre, 'listening');
  const { port } = portaLivre.address();
  portaLivre.close();
  await once(portaLivre, 'close');

  filho = spawn(process.execPath, ['--input-type=module', '-e',
    "import { iniciarConectorGPT } from './src/conector-gpt.js'; await iniciarConectorGPT();"], {
    cwd: raiz,
    env: { ...process.env, GPT: '1', GPT_PORTA: String(port), GPT_WHATSAPP_LEITURA: habilitar ? '1' : '0', WHATSAPP: whatsapp ? '1' : '0', NGROK_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  filho.stdout.on('data', (dado) => { logs += dado; });
  filho.stderr.on('data', (dado) => { logs += dado; });


  const origem = `http://127.0.0.1:${port}`;
  async function post(rota, method, params) {
    return fetch(origem + rota, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }
  for (let i = 0; i < 100 && !logs.includes('conector pronto'); i++) {
    assert.equal(filho.exitCode, null, logs);
    await esperar(20);
  }
  assert.match(logs, /conector pronto/);
  const chaveEnvio = await readFile(path.join(raiz, 'dados/gpt-segredo.txt'), 'utf8');
  const link = await readFile(path.join(raiz, 'LINK-DO-CHATGPT.txt'), 'utf8');
  const chaveLeitura = /mcp-leitura\?chave=([\w-]+)/.exec(link)?.[1];
  return { post, chaveEnvio, chaveLeitura, logs: () => logs };
}

test('MCP bloqueia a leitura por padrão ou com o WhatsApp desativado', async (t) => {
  for (const argumento of [[false, true], [true, false]]) {
    const { post, chaveEnvio, chaveLeitura } = await iniciarMcp(t, ...argumento);
    assert.equal(chaveLeitura, undefined);
    assert.equal((await post(`/mcp-leitura?chave=${chaveEnvio}`, 'tools/list')).status, 404);
    const envio = await (await post(`/mcp/${chaveEnvio}`, 'tools/list')).json();
    assert.ok(envio.result.tools.some((f) => f.name === 'enviar_whatsapp'));
    assert.ok(envio.result.tools.every((f) => f.name !== 'consultar_mensagens_whatsapp'));
  }
});

test('MCP autentica a consulta e restringe cada credencial ao próprio conjunto de ferramentas', async (t) => {
  const { post, chaveEnvio, chaveLeitura, logs } = await iniciarMcp(t, true);
  assert.match(chaveLeitura, /^[\w-]{32}$/);
  assert.notEqual(chaveLeitura, chaveEnvio);
  const leitura = `/mcp-leitura?chave=${chaveLeitura}`;
  const envio = `/mcp/${chaveEnvio}`;
  for (const rota of ['/mcp-leitura', `/mcp-leitura?chave=${chaveEnvio}`, `/mcp/${chaveLeitura}`, '/mcp-leitura?chave=' + 'é'.repeat(32)]) {
    assert.equal((await post(rota, 'tools/list')).status, 404);
  }
  const lista = await (await post(leitura, 'tools/list')).json();
  assert.deepEqual(lista.result.tools.map((f) => f.name), ['consultar_mensagens_whatsapp']);
  assert.equal(lista.result.tools[0].annotations.readOnlyHint, true);
  const params = { name: 'consultar_mensagens_whatsapp', arguments: { palavra_chave: 'cotação', limite: 1 } };
  assert.equal((await (await post(envio, 'tools/call', params)).json()).error.code, -32602);
  assert.equal((await (await post(leitura, 'tools/call', { name: 'enviar_whatsapp' })).json()).error.code, -32602);
  const resposta = await post(leitura, 'tools/call', params);
  assert.equal(resposta.headers.get('cache-control'), 'no-store');
  const { result } = await resposta.json();
  assert.equal(result.structuredContent.mensagens[0].texto, 'Pode enviar a cotação por e-mail?');
  const invalidos = await (await post(leitura, 'tools/call', { ...params, arguments: { palavra_chave: 'DADO-FICTICIO', limite: 31 } })).json();
  assert.equal(invalidos.result.isError, true);
  assert.doesNotMatch(logs(), /DADO-FICTICIO|Pode enviar a cotação/);
});
