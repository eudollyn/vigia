// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026
// Integração do conector MCP por HTTP local: autenticação, separação das chaves, ferramentas de consulta
// (banco em memória com dados fictícios) e log sem conteúdo de mensagens.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as esperar } from 'node:timers/promises';
import { test } from 'node:test';

const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  await symlink(path.join(RAIZ_REPO, 'node_modules'), path.join(raiz, 'node_modules'), 'junction');
  for (const nome of ['conector-gpt.js', 'config.js', 'whatsapp-banco.js', 'ferramentas-whatsapp.js']) {
    await cp(path.join(RAIZ_REPO, 'src', nome), path.join(src, nome));
  }
  await writeFile(path.join(src, 'avisos.js'), 'export const log = console.log, dizer = () => {}, naFila = async () => {}, notificar = () => {};');
  // WhatsApp falso: banco em memória com mensagens fictícias
  await writeFile(path.join(src, 'whatsapp.js'), `
    import { BancoWhatsApp } from './whatsapp-banco.js';
    const b = new BancoWhatsApp(':memory:');
    const ts = Math.floor(Date.parse('2026-11-25T12:00:00Z') / 1000);
    b.gravarContato({ jid: '5531000000001@s.whatsapp.net', notify: 'Érica Suprimentos' });
    b.gravarMensagem({ key: { id: 'A1', remoteJid: '5531000000001@s.whatsapp.net', fromMe: false }, messageTimestamp: ts, message: { conversation: 'Pode enviar a cotação por e-mail?' } });
    b.gravarMensagem({ key: { id: 'A2', remoteJid: '5531000000001@s.whatsapp.net', fromMe: true }, messageTimestamp: ts + 60, message: { conversation: 'Envio agora.' } });
    export const bancoWhatsApp = () => b;
    export const statusWhatsApp = () => ({ situacao: 'conectado' });
    export const sincronizarHistorico = async () => ({ situacao: 'sem_resposta_do_celular' });
    export const baixarAnexo = async () => ({ situacao: 'sem_anexo' });
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
  for (let i = 0; i < 250 && !logs.includes('conector pronto'); i++) {
    assert.equal(filho.exitCode, null, logs);
    await esperar(20);
  }
  assert.match(logs, /conector pronto/);
  const chaveEnvio = await readFile(path.join(raiz, 'dados/gpt-segredo.txt'), 'utf8');
  const link = await readFile(path.join(raiz, 'LINK-DO-CHATGPT.txt'), 'utf8');
  const chaveLeitura = /mcp-leitura\?chave=([\w-]+)/.exec(link)?.[1];
  return { post, chaveEnvio, chaveLeitura, logs: () => logs };
}

const FERRAMENTAS_LEITURA = ['consultar_mensagens_whatsapp', 'buscar_mensagens_whatsapp', 'consultar_historico_conversa', 'consultar_anexos_whatsapp',
  'obter_anexo_whatsapp', 'listar_conversas_whatsapp', 'listar_grupos_whatsapp', 'listar_contatos_whatsapp', 'sincronizar_historico_whatsapp', 'verificar_status_whatsapp'];

test('MCP bloqueia a leitura por padrão ou com o WhatsApp desativado', async (t) => {
  for (const argumento of [[false, true], [true, false]]) {
    const { post, chaveEnvio, chaveLeitura } = await iniciarMcp(t, ...argumento);
    assert.equal(chaveLeitura, undefined);
    assert.equal((await post(`/mcp-leitura?chave=${chaveEnvio}`, 'tools/list')).status, 404);
    const envio = await (await post(`/mcp/${chaveEnvio}`, 'tools/list')).json();
    assert.ok(envio.result.tools.some((f) => f.name === 'enviar_whatsapp'));
    assert.ok(envio.result.tools.every((f) => !FERRAMENTAS_LEITURA.includes(f.name)));
  }
});

test('MCP autentica a consulta e restringe cada credencial ao próprio conjunto de ferramentas', async (t) => {
  const { post, chaveEnvio, chaveLeitura, logs } = await iniciarMcp(t, true);
  assert.match(chaveLeitura, /^[\w-]{32}$/);
  assert.notEqual(chaveLeitura, chaveEnvio);
  const leitura = `/mcp-leitura?chave=${chaveLeitura}`;
  const envio = `/mcp/${chaveEnvio}`;
  for (const rota of ['/', '/mcp-leitura', `/mcp-leitura?chave=${chaveEnvio}`, `/mcp/${chaveLeitura}`, '/mcp-leitura?chave=' + 'é'.repeat(32)]) {
    assert.equal((await post(rota, 'tools/list')).status, 404);
  }
  const lista = await (await post(leitura, 'tools/list')).json();
  assert.deepEqual(lista.result.tools.map((f) => f.name).sort(), [...FERRAMENTAS_LEITURA].sort());
  assert.ok(lista.result.tools.every((f) => f.annotations.readOnlyHint === true));
  const envioLista = await (await post(envio, 'tools/list')).json();
  assert.deepEqual(envioLista.result.tools.map((f) => f.name), ['listar_arquivos', 'pesquisar_contatos', 'enviar_whatsapp', 'enviar_email', 'responder_email']);
  const params = { name: 'consultar_mensagens_whatsapp', arguments: { palavra_chave: 'cotação', limite: 1 } };
  assert.equal((await (await post(envio, 'tools/call', params)).json()).error.code, -32602);
  assert.equal((await (await post(leitura, 'tools/call', { name: 'enviar_whatsapp' })).json()).error.code, -32602);
  const resposta = await post(leitura, 'tools/call', params);
  assert.equal(resposta.headers.get('cache-control'), 'no-store');
  const { result } = await resposta.json();
  assert.equal(result.structuredContent.situacao, 'ok');
  assert.equal(result.structuredContent.mensagens[0].conteudo, 'Pode enviar a cotação por e-mail?');
  assert.equal(result.structuredContent.mensagens[0].data_hora, '2026-11-25T09:00:00-03:00');
  const conversa = await (await post(leitura, 'tools/call', { name: 'consultar_historico_conversa', arguments: { telefone: '(31) 00000-0001' } })).json();
  assert.deepEqual(conversa.result.structuredContent.mensagens.map((m) => m.direcao), ['recebida', 'enviada']);
  const invalidos = await (await post(leitura, 'tools/call', { ...params, arguments: { palavra_chave: 'DADO-FICTICIO', limite: 101 } })).json();
  assert.equal(invalidos.result.isError, true);
  const dataRuim = await (await post(leitura, 'tools/call', { name: 'consultar_mensagens_whatsapp', arguments: { data_inicial: 'DATA-FICTICIA' } })).json();
  assert.equal(dataRuim.result.isError, true);
  await esperar(50);
  assert.doesNotMatch(logs(), /DADO-FICTICIO|DATA-FICTICIA|Pode enviar a cotação|Envio agora/);
});
