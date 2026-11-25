// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito: veja o arquivo NOTICE)
// Conector do ChatGPT (MCP pela internet). O ChatGPT chama as ferramentas daqui para mandar a cotação para o
// fabricante pelo WhatsApp ou por e-mail, com os PDFs da pasta "arquivos-para-o-gpt". Envia DIRETO (você já leu e
// aprovou o texto no ChatGPT) e o Vigia fala para você o que foi enviado.
// Segurança: o endereço tem um código secreto (dados/gpt-segredo.txt); sem ele, tudo responde 404.
// O túnel (ngrok) só liga com NGROK_TOKEN no .env (use o CONECTAR-CHATGPT.bat).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';
import { log, dizer, naFila, notificar } from './avisos.js';

const RAIZ = path.resolve(DADOS, '..');
export const PASTA_ARQUIVOS = path.join(RAIZ, 'arquivos-para-o-gpt');
const ARQ_SEGREDO = path.join(DADOS, 'gpt-segredo.txt');
const ARQ_LINK = path.join(RAIZ, 'LINK-DO-CHATGPT.txt');
const TIPOS = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function segredo() {
  try { const s = fs.readFileSync(ARQ_SEGREDO, 'utf8').trim(); if (s.length >= 24) return s; } catch {}
  const s = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(ARQ_SEGREDO, s);
  return s;
}

// ---------- arquivos que podem ir junto ----------
export function listarArquivos() {
  fs.mkdirSync(PASTA_ARQUIVOS, { recursive: true });
  return fs.readdirSync(PASTA_ARQUIVOS, { withFileTypes: true })
    .filter((d) => d.isFile() && TIPOS[path.extname(d.name).toLowerCase()])
    .map((d) => {
      const caminho = path.join(PASTA_ARQUIVOS, d.name);
      return { nome: d.name, tipo: TIPOS[path.extname(d.name).toLowerCase()], caminho, kb: Math.round(fs.statSync(caminho).size / 1024) };
    });
}
/** nomes pedidos ("ficha técnica", "ficha_tecnica.pdf") → arquivos da pasta. Erro claro se algum não existir. */
export function acharArquivos(pedidos) {
  const todos = listarArquivos();
  const r = [];
  for (const p of [].concat(pedidos || []).map(String).filter((x) => x.trim())) {
    const q = norm(path.basename(p).replace(/\.[a-z0-9]{2,4}$/i, ''));
    const achado = todos.find((a) => norm(a.nome.replace(/\.[^.]+$/, '')) === q)
      || todos.find((a) => norm(a.nome).includes(q))
      || todos.find((a) => q.split(' ').filter((w) => w.length > 2).every((w) => norm(a.nome).includes(w)));
    if (!achado) throw new Error(`Arquivo "${p}" não está na pasta arquivos-para-o-gpt. Disponíveis: ${todos.map((a) => a.nome).join(', ') || 'nenhum'}.`);
    if (achado.kb > 15 * 1024) throw new Error(`O arquivo ${achado.nome} passa de 15 MB.`);
    if (!r.includes(achado)) r.push(achado);
  }
  return r;
}

// limite de segurança: no máximo 30 envios por hora pelo ChatGPT
const envios = [];
function conferirLimite() {
  const agora = Date.now();
  while (envios.length && agora - envios[0] > 3_600_000) envios.shift();
  if (envios.length >= 30) throw new Error('Limite de 30 envios por hora pelo ChatGPT atingido. Tente mais tarde.');
  envios.push(agora);
}
const falarArquivos = (arqs) => (arqs.length ? `, com ${arqs.length === 1 ? 'o arquivo' : 'os arquivos'} ${arqs.map((a) => a.nome.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')).join(' e ')}` : '');

const ferramentas = [
  {
    name: 'listar_arquivos', title: 'Listar arquivos para anexar',
    description: 'Lista os arquivos (PDF etc.) que podem ser anexados nos envios, como a ficha técnica da empresa. Use os nomes daqui no campo "arquivos".',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async () => ({ pasta: 'arquivos-para-o-gpt', arquivos: listarArquivos().map(({ nome, kb }) => ({ nome, kb })) }),
  },
  {
    name: 'pesquisar_contatos', title: 'Pesquisar contatos do WhatsApp',
    description: 'Procura contatos salvos e grupos do WhatsApp do usuário pelo nome. Devolve nome e número.',
    inputSchema: { type: 'object', properties: { nome: { type: 'string', description: 'Nome ou parte do nome' } }, required: ['nome'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ nome }) => ({ resultados: (await import('./whatsapp.js')).pesquisarContatos(nome) }),
  },
  {
    name: 'enviar_whatsapp', title: 'Enviar pelo WhatsApp',
    description: 'Envia NA HORA uma mensagem de WhatsApp do número do usuário, com arquivos anexados (ex.: a ficha técnica em PDF), '
      + 'para um número (com DDD; sem +55 assume Brasil) ou um contato salvo. Use só quando a usuária pedir para enviar/solicitar pelo WhatsApp, '
      + 'com o texto que ela já viu na conversa. Não pede confirmação de novo.',
    inputSchema: { type: 'object', properties: {
      destino: { type: 'string', description: 'Número com DDD (ex.: 31 99999-9999 ou +55 31 99999-9999) ou nome do contato salvo' },
      mensagem: { type: 'string', description: 'Texto da mensagem' },
      arquivos: { type: 'array', items: { type: 'string' }, description: 'Nomes dos arquivos da pasta (veja listar_arquivos), ex.: ["ficha técnica"]' },
    }, required: ['destino', 'mensagem'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async ({ destino, mensagem, arquivos }) => {
      const arqs = acharArquivos(arquivos);
      if (!String(mensagem || '').trim() && !arqs.length) throw new Error('Mensagem vazia.');
      conferirLimite();
      const { enviarComArquivos } = await import('./whatsapp.js');
      const r = await enviarComArquivos(destino, String(mensagem || '').trim(), arqs);
      log(`ChatGPT: WhatsApp enviado para ${r.para}${r.numero ? ` (${r.numero})` : ''}${arqs.length ? ` + ${arqs.map((a) => a.nome).join(', ')}` : ''}`);
      notificar('ChatGPT enviou pelo WhatsApp', `Para ${r.para}${arqs.length ? ` · ${arqs.map((a) => a.nome).join(', ')}` : ''}`);
      naFila(() => dizer(`O ChatGPT enviou a mensagem pelo WhatsApp para ${r.para}${falarArquivos(arqs)}.`)).catch(() => {});
      return { enviado: true, canal: 'whatsapp', para: r.para, numero: r.numero, arquivos: arqs.map((a) => a.nome) };
    },
  },
  {
    name: 'enviar_email', title: 'Enviar e-mail',
    description: 'Envia NA HORA um e-mail do endereço do usuário (fica salvo nos Enviados), com arquivos anexados (ex.: a ficha técnica em PDF). '
      + 'Use só quando a usuária pedir para enviar/solicitar por e-mail, com o texto que ela já viu na conversa. Não pede confirmação de novo.',
    inputSchema: { type: 'object', properties: {
      para: { type: 'string', description: 'E-mail do destinatário (vários separados por vírgula)' },
      cc: { type: 'string', description: 'Com cópia (opcional)' },
      assunto: { type: 'string' },
      mensagem: { type: 'string', description: 'Corpo do e-mail, em texto' },
      arquivos: { type: 'array', items: { type: 'string' }, description: 'Nomes dos arquivos da pasta (veja listar_arquivos), ex.: ["ficha técnica"]' },
    }, required: ['para', 'assunto', 'mensagem'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async ({ para, cc, assunto, mensagem, arquivos }) => {
      const arqs = acharArquivos(arquivos);
      conferirLimite();
      const { enviarEmail } = await import('./enviar-email.js');
      const r = await enviarEmail({ para, cc, assunto, mensagem, arquivos: arqs });
      const quem = r.para.join(', ');
      log(`ChatGPT: e-mail enviado para ${quem} ("${assunto}")${arqs.length ? ` + ${arqs.map((a) => a.nome).join(', ')}` : ''}`);
      notificar('ChatGPT enviou um e-mail', `Para ${quem} · ${assunto}`);
      const dominio = r.para[0].split('@')[1]?.replace(/\.(com|net|org|ind|ind\.br|com\.br|net\.br)$/i, '').replace(/\.(com|br)$/i, '') || r.para[0];
      naFila(() => dizer(`O ChatGPT enviou o e-mail para ${dominio}${falarArquivos(arqs)}. Assunto: ${assunto}.`)).catch(() => {});
      return { enviado: true, canal: 'email', para: r.para, cc: r.cc, assunto, arquivos: arqs.map((a) => a.nome) };
    },
  },
];

async function responder({ id, method, params }) {
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const erro = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') return ok({
    protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'vigia', title: 'Vigia (WhatsApp e e-mail)', version: '1.0.0' },
    instructions: 'Envio de cotações pelo WhatsApp e por e-mail do usuário, com anexos (ex.: a ficha técnica). '
      + 'Mostre o texto na conversa antes; quando ela pedir para enviar/solicitar, chame enviar_whatsapp ou enviar_email direto. '
      + 'Para anexar a ficha técnica, use listar_arquivos e passe o nome em "arquivos".',
  });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: ferramentas.map(({ run, ...f }) => f) });
  if (method === 'tools/call') {
    const f = ferramentas.find((x) => x.name === params?.name);
    if (!f) return erro(-32602, 'Ferramenta desconhecida: ' + params?.name);
    try {
      const r = await f.run(params.arguments || {});
      return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 1) }], structuredContent: r });
    } catch (e) {
      log(`ChatGPT: ${f.name} falhou (${e.message})`);
      return ok({ content: [{ type: 'text', text: 'Erro: ' + e.message }], isError: true });
    }
  }
  if (method === 'resources/list') return ok({ resources: [] });
  if (method === 'prompts/list') return ok({ prompts: [] });
  return erro(-32601, 'Método não suportado: ' + method);
}

export async function iniciarConectorGPT() {
  if (!config.gpt) return;
  fs.mkdirSync(PASTA_ARQUIVOS, { recursive: true });
  const chave = segredo();
  const servidor = http.createServer(async (req, res) => {
    const partes = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
    const tokenOk = partes[0] === 'mcp' && partes[1]?.length === chave.length && crypto.timingSafeEqual(Buffer.from(partes[1]), Buffer.from(chave));
    if (!tokenOk) { res.writeHead(404); return res.end(); }
    if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let corpo = '';
    for await (const c of req) { corpo += c; if (corpo.length > 2e6) { res.writeHead(413); return res.end(); } }
    let pedido; try { pedido = JSON.parse(corpo); } catch { res.writeHead(400); return res.end(); }
    const lista = Array.isArray(pedido) ? pedido : [pedido];
    const respostas = (await Promise.all(lista.map((p) => (p?.id === undefined || p?.id === null ? null : responder(p))))).filter(Boolean);
    if (!respostas.length) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(pedido) ? respostas : respostas[0]));
  });
  servidor.on('error', (e) => log(`ChatGPT: conector não ligou (${e.message})`));
  await new Promise((ok) => servidor.listen(config.gptPorta, '127.0.0.1', ok));

  if (!config.ngrokToken) {
    fs.writeFileSync(ARQ_LINK, 'O conector do ChatGPT ainda não está na internet.\r\nRode o CONECTAR-CHATGPT.bat e cole o seu token do ngrok.\r\n');
    log('ChatGPT: conector pronto só neste PC (falta o token do ngrok: rode o CONECTAR-CHATGPT.bat)');
    return;
  }
  try {
    const ngrok = (await import('@ngrok/ngrok')).default;
    const ouvinte = await ngrok.forward({ addr: `127.0.0.1:${config.gptPorta}`, authtoken: config.ngrokToken, ...(config.ngrokDominio ? { domain: config.ngrokDominio } : {}) });
    const link = `${ouvinte.url()}/mcp/${chave}`;
    fs.writeFileSync(ARQ_LINK, `Endereço do Vigia para colar no ChatGPT (chatgpt.com/plugins > Adicionar servidor MCP personalizado, Sem autenticação):\r\n\r\n${link}\r\n\r\n`
      + 'Guarde em segredo: quem tiver este endereço consegue enviar mensagens pelo seu WhatsApp e e-mail.\r\n'
      + (config.ngrokDominio ? '' : 'ATENÇÃO: sem NGROK_DOMINIO o endereço muda toda vez que o Vigia reinicia.\r\n'));
    log(`ChatGPT: conector na internet (endereço em LINK-DO-CHATGPT.txt)${config.ngrokDominio ? '' : ' — sem domínio fixo, o endereço muda a cada reinício'}`);
  } catch (e) {
    const msg = /authtoken|ERR_NGROK_10[57]|authentic/i.test(e.message) ? 'o token do ngrok está errado'
      : /domain|ERR_NGROK_3(19|20)/i.test(e.message) ? 'o domínio do ngrok está errado ou não é da sua conta'
      : /ERR_NGROK_108|already online|limited to 1/i.test(e.message) ? 'o ngrok já está ligado em outro programa (feche o outro)' : e.message;
    fs.writeFileSync(ARQ_LINK, `O túnel do ngrok não ligou: ${msg}.\r\nRode o CONECTAR-CHATGPT.bat de novo.\r\n`);
    log(`ChatGPT: túnel não ligou (${msg})`);
  }
}
