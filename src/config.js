import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DADOS = path.join(RAIZ, 'dados');
fs.mkdirSync(DADOS, { recursive: true });

// Leitor próprio do .env: o do Node corta a partir de "#" mesmo entre aspas (quebrava senhas com #).
// Valor entre aspas é lido literalmente; sem aspas, "#" só vira comentário se vier depois de um espaço.
const envPath = path.join(RAIZ, '.env');
if (fs.existsSync(envPath)) {
  for (const linha of fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
    if (!m) continue;
    let v = m[2];
    const q = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(v);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, '').trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const e = process.env;
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

function faixaSilencio(txt) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(txt || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const config = {
  email: {
    usuario: (e.EMAIL_USUARIO || '').trim(),
    senha: e.EMAIL_SENHA || '',
    host: (e.IMAP_HOST || 'email-ssl.com.br').trim(),
    porta: num(e.IMAP_PORTA, 993),
  },
  whatsapp: num(e.WHATSAPP, 1) === 1,
  voz: num(e.VOZ, 1) === 1,
  vozNome: (e.VOZ_NOME || 'Microsoft Maria Desktop').trim(),
  vozVelocidade: num(e.VOZ_VELOCIDADE, 1),
  // motor da voz: google (Gemini TTS, precisa de GEMINI_API_KEY) ou windows
  vozMotor: (e.VOZ_MOTOR || (e.GEMINI_API_KEY ? 'google' : 'windows')).trim().toLowerCase(),
  vozGoogle: (e.VOZ_GOOGLE || 'Kore').trim(),
  // voz Microsoft (VOZ_MOTOR=microsoft): pt-BR-FranciscaNeural, pt-BR-ThalitaMultilingualNeural, pt-BR-AntonioNeural
  vozMs: (e.VOZ_MICROSOFT || 'pt-BR-FranciscaNeural').trim(),
  vozMsVelocidade: (e.VOZ_MICROSOFT_VELOCIDADE || '+5%').trim(),
  vozGoogleModelo: (e.VOZ_GOOGLE_MODELO || 'gemini-3.8-flash-tts').trim(),
  vozEstilo: (e.VOZ_ESTILO || '').trim(), // vazio = fala só a mensagem (recomendado)
  // Onde a voz toca: notebook (página aberta no navegador; sem ela, toca no PC), pc, ou ambos
  saidaVoz: (e.SAIDA_VOZ || 'notebook').trim().toLowerCase(),
  altoFalantePorta: num(e.ALTO_FALANTE_PORTA, 8765),
  saudacaoNome: (e.SAUDACAO_NOME ?? '').trim(), // ex.: "Sr. João" → "Bom dia, Sr. João!"
  // Como a voz deve FALAR certas palavras (a tela não muda). Formato: Thalyta=Talíta;Outro=Jeito de falar
  pronuncia: (e.PRONUNCIA ?? '').split(';').map((p) => p.split('=').map((s) => s.trim())).filter(([a, b]) => a && b),
  // Previsão do tempo no bom dia (padrão: São Paulo; troque pela sua cidade)
  climaCidade: (e.CLIMA_CIDADE || 'São Paulo').trim(),
  climaLat: num(e.CLIMA_LAT, -23.55),
  climaLon: num(e.CLIMA_LON, -46.63),
  // De onde vem a voz para "responda": notebook (se a página estiver com microfone liberado; senão o do PC) ou pc
  micOrigem: (e.MICROFONE_ORIGEM || 'notebook').trim().toLowerCase(),
  // Contatos privados: a voz diz só "Mensagem de <nome>", sem conteúdo (pedaço do nome, separados por vírgula)
  privados: (e.PRIVADOS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // 1 = o aviso diz só de quem é (e o grupo); o conteúdo é lido quando você diz "leia". 0 = já lê tudo no aviso.
  lerSobDemanda: num(e.LER_SOB_DEMANDA, 1) === 1,
  // Responder por voz (só WhatsApp): depois de cada aviso o microfone abre por alguns segundos esperando "responda"
  responderVoz: num(e.RESPONDER_VOZ, 1) === 1,
  microfone: (e.MICROFONE || '').trim(),           // vazio = escolhe sozinho (prefere headset/USB)
  micLimiar: num(e.MIC_LIMIAR, -45),               // dB: abaixo disso é silêncio
  // mensagens picadas: junta as seguidas da mesma conversa até a pessoa ficar X s sem mandar nada (máximo 1 min)
  agruparMs: num(e.AGRUPAR_SEGUNDOS, 20) * 1000,
  // depois de avisar alguém, não fala de novo dessa pessoa por X min (só tela); no fim: "mandou mais N mensagens"
  pausaPessoaMs: num(e.PAUSA_MESMA_PESSOA_MIN, 5) * 60_000,
  janelaMs: num(e.JANELA_SEGUNDOS, 7) * 1000,      // quanto tempo espera o "responda" depois do aviso
  silencio: faixaSilencio(e.SILENCIO ?? '22-7'),
  resumoBaixaMin: num(e.RESUMO_BAIXA_MIN, 60),
  // ÚNICOS chats/remetentes de prioridade baixa (pedaço do nome, separados por vírgula). Todo o resto avisa e fala.
  baixaPrioridade: (e.BAIXA_PRIORIDADE ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // quem resume: gemini | claude | simples (padrão: gemini se houver chave, senão claude)
  resumoIA: (e.RESUMO_IA || (e.GEMINI_API_KEY ? 'gemini' : 'claude')).trim().toLowerCase(),
  geminiChave: (e.GEMINI_API_KEY || '').trim(),
  geminiModelo: (e.GEMINI_MODELO || 'gemini-flash-lite-latest').trim(),
  geminiReservas: (e.GEMINI_RESERVAS || 'gemini-3.5-flash-lite,gemini-3.8-flash,gemini-flash-latest').split(',').map((s) => s.trim()).filter(Boolean),
  claude: num(e.CLAUDE, 1) === 1,
  claudeModelo: (e.CLAUDE_MODELO || 'haiku').trim(),
  claudeCaminho: (e.CLAUDE_CAMINHO || '').trim(),
};

export const emailAtivo = () => Boolean(config.email.usuario && config.email.senha);
