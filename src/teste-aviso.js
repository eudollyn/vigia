// npm run teste-aviso → mostra uma notificação e fala uma frase, para conferir som e voz.
import { avisar } from './avisos.js';
import { resumir } from './resumo.js';

const texto = 'Oi! Aqui é do fornecedor. O pedido 4521 sai amanhã cedo, mas preciso que você confirme o endereço de entrega até as 17h de hoje.';
const r = await resumir({ canal: 'whatsapp', de: 'Teste do Vigia', texto });
await avisar({ canal: 'whatsapp', de: 'Teste do Vigia', textoOriginal: texto, ...r });
setTimeout(() => process.exit(0), 40_000);
