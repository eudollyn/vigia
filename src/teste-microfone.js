// npm run teste-microfone → fala "diga uma frase", grava e mostra o que entendeu.
import { dizer, log } from './avisos.js';
import { microfone, ouvir } from './microfone.js';
import { transcrever } from './transcrever.js';
log(`Teste do microfone em: ${microfone()}`);
await dizer('Teste do microfone. Diga uma frase.');
const t0 = Date.now();
const audio = await ouvir({ esperaMs: 8000, silencioMs: 1400, maxMs: 15000 });
if (!audio) { log('Teste: não detectei fala (microfone mudo, volume baixo ou MIC_LIMIAR alto demais).'); process.exit(0); }
log(`Teste: gravei ${(audio.length / 32000).toFixed(1)} s de fala em ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
const texto = await transcrever(audio);
log(`Teste: entendi "${texto}"`);
await dizer(`Entendi: ${texto || 'nada'}`);
process.exit(0);
