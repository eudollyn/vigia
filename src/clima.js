// Previsão do tempo para o bom dia (Open-Meteo: grátis, sem chave). Só a cidade vai na consulta.
import { config } from './config.js';

const DESCRICAO = (c) =>
  c === 0 ? 'céu limpo' : c <= 2 ? 'poucas nuvens' : c === 3 ? 'tempo nublado' : c <= 48 ? 'neblina' :
  c <= 57 ? 'garoa' : c <= 67 ? 'chuva' : c <= 77 ? 'neve' : c <= 82 ? 'pancadas de chuva' : 'tempestade';

/** → frase pronta, ou '' se não conseguir. */
/** Temperatura de agora, em graus (ou null). */
export async function temperaturaAgora() {
  try {
    const u = new URL('https://api.open-meteo.com/v1/forecast');
    u.search = new URLSearchParams({ latitude: String(config.climaLat), longitude: String(config.climaLon), timezone: 'America/Sao_Paulo', current: 'temperature_2m' });
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const t = (await r.json()).current?.temperature_2m;
    return t == null ? null : Math.round(t);
  } catch { return null; }
}

export async function previsaoHoje() {
  try {
    const u = new URL('https://api.open-meteo.com/v1/forecast');
    u.search = new URLSearchParams({
      latitude: String(config.climaLat), longitude: String(config.climaLon), timezone: 'America/Sao_Paulo', forecast_days: '1',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    });
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return '';
    const d = (await r.json()).daily;
    const max = Math.round(d.temperature_2m_max[0]), min = Math.round(d.temperature_2m_min[0]);
    const chuva = d.precipitation_probability_max?.[0];
    const txtChuva = chuva == null ? '' : chuva >= 60 ? ` Leve guarda-chuva: ${chuva} por cento de chance de chuva.` :
      chuva >= 30 ? ` ${chuva} por cento de chance de chuva.` : ' Sem previsão de chuva.';
    return `Em ${config.climaCidade}, previsão de ${DESCRICAO(d.weather_code[0])}, máxima de ${max} e mínima de ${min} graus.${txtChuva}`;
  } catch { return ''; }
}
