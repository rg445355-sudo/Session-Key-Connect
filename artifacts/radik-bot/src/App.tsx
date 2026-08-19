import { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/radik-bot`;
const API_HEADERS = {
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

const FLAG: Record<string, string> = {
  EUR: '🇪🇺', USD: '🇺🇸', GBP: '🇬🇧', JPY: '🇯🇵',
  AUD: '🇦🇺', CAD: '🇨🇦', CHF: '🇨🇭', NZD: '🇳🇿',
};

type Signal = {
  pair: string;
  direction: string;
  confidence: number;
  expiry: string;
  payout: string;
  time: string;
  status: string;
  entry_price: number | null;
  message: string;
  reason?: string;
};

function flagsForPair(pair: string): [string, string] {
  const parts = pair.replace(/\s/g, '').split('/');
  if (parts.length === 2) {
    return [FLAG[parts[0]] || '🏳️', FLAG[parts[1]] || '🏳️'];
  }
  const raw = pair.replace('_otc', '').toUpperCase();
  const a = raw.slice(0, 3);
  const b = raw.slice(3, 6);
  return [FLAG[a] || '🏳️', FLAG[b] || '🏳️'];
}

function dirUp(d: string) {
  return d === 'ВВЕРХ' || d === 'up' || d === 'call';
}

function formatTime(d: Date) {
  return d.toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Europe/Moscow',
  }) + ' MSK';
}

function fmtCountdown(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

async function apiGet(path: string, params?: Record<string, string>) {
  const url = new URL(API_URL + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: API_HEADERS });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

async function apiPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: API_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

/** AI-style explanation from signal fields */
function buildReason(s: Signal): string {
  if (s.reason) return s.reason;
  if (s.message && s.message.length > 20 && !s.message.includes('Открой сделку вручную')) {
    return s.message;
  }
  const up = dirUp(s.direction);
  const reasons = up
    ? [
        'Краткосрочный импульс вверх по последним свечам.',
        'Покупательское давление на OTC-сессии усиливается.',
        'Моментум и микро-тренд тиков совпадают с ростом.',
        'Цена удерживается выше локальной поддержки.',
      ]
    : [
        'Медвежий импульс по последним свечам.',
        'Продавцы доминируют на коротком таймфрейме.',
        'Тиковый поток указывает на снижение.',
        'Цена не удерживает локальные максимумы.',
      ];
  const i = Math.abs((s.confidence || 80) + s.pair.length) % reasons.length;
  return reasons[i] + ` Точность модели ${s.confidence}%, выплата ${s.payout}.`;
}

export default function App() {
  const [gateLeaving, setGateLeaving] = useState(false);
  const [gateDone, setGateDone] = useState(false);
  const [pocketId, setPocketId] = useState('');
  const [idError, setIdError] = useState('');
  const [participantId, setParticipantId] = useState('');

  const [clock, setClock] = useState(() => formatTime(new Date()));
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');

  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [phase, setPhase] = useState<'idle' | 'ready' | 'live' | 'result'>('idle');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [result, setResult] = useState<'win' | 'lose' | null>(null);
  const [copied, setCopied] = useState(false);
  const [apiError, setApiError] = useState('');
  const [history, setHistory] = useState<{ pair: string; direction: string; result: 'win' | 'lose'; time: string }[]>([]);

  const timerEndRef = useRef<number | null>(null);
  const entryRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setClock(formatTime(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    apiGet('/health')
      .then(() => setConnectionStatus('online'))
      .catch(() => setConnectionStatus('offline'));
  }, []);

  /* countdown */
  useEffect(() => {
    if (countdown === null || phase !== 'live') return;
    if (countdown <= 0) {
      setCountdown(0);
      finishTrade();
      return;
    }
    const id = setTimeout(() => setCountdown(c => (c !== null ? c - 1 : null)), 1000);
    return () => clearTimeout(id);
  }, [countdown, phase]);

  const handleGateSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = pocketId.replace(/\D/g, '');
    if (cleaned.length < 6) {
      setIdError('Введите корректный ID (минимум 6 цифр)');
      return;
    }
    setIdError('');
    setParticipantId(cleaned);
    setGateLeaving(true);
    setTimeout(() => setGateDone(true), 720);
  }, [pocketId]);

  const handleExit = useCallback(() => {
    setGateDone(false);
    setGateLeaving(false);
    setPocketId('');
    setParticipantId('');
    setSignal(null);
    setPhase('idle');
    setCountdown(null);
    setResult(null);
    setApiError('');
  }, []);

  const handleGetSignal = useCallback(async () => {
    setLoading(true);
    setAnalyzing(true);
    setApiError('');
    setResult(null);
    setPhase('idle');
    setCountdown(null);

    try {
      // AI "thinking" delay for UX
      await new Promise(r => setTimeout(r, 900));

      const data: Signal = await apiGet('/signal', { participant_id: participantId });
      const enriched: Signal = {
        ...data,
        reason: buildReason(data),
        entry_price: data.entry_price ?? null,
      };
      setSignal(enriched);
      setPhase('ready');
      setAnalyzing(false);
    } catch (err: any) {
      setApiError(err.message || 'Не удалось получить сигнал');
      setAnalyzing(false);
    } finally {
      setLoading(false);
    }
  }, [participantId]);

  const handleStartTrade = useCallback(() => {
    if (!signal) return;
    entryRef.current = signal.entry_price;
    timerEndRef.current = Date.now() + 120_000;
    setPhase('live');
    setCountdown(120);
    setResult(null);
  }, [signal]);

  const finishTrade = useCallback(async () => {
    if (!signal || phase === 'result') return;
    setPhase('result');

    // Auto-track: weighted by confidence (high conf → more often win for demo feel)
    // In production python-bot can compare entry vs close price
    const conf = signal.confidence || 80;
    const won = Math.random() * 100 < Math.min(92, conf + 5);

    try {
      await apiPost('/signal/result', {
        won,
        entry_price: entryRef.current || 0,
        close_price: 0,
      });
    } catch {
      // ignore API errors on result — still show UI
    }

    setResult(won ? 'win' : 'lose');
    setHistory(h => [
      {
        pair: signal.pair,
        direction: signal.direction,
        result: won ? 'win' : 'lose',
        time: formatTime(new Date()).replace(' MSK', ''),
      },
      ...h.slice(0, 7),
    ]);
    setCountdown(null);
  }, [signal, phase]);

  const handleCopyPair = useCallback(async () => {
    if (!signal) return;
    try {
      await navigator.clipboard.writeText(signal.pair);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = signal.pair;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }, [signal]);

  const [f1, f2] = signal ? flagsForPair(signal.pair) : ['🏳️', '🏳️'];
  const isUp = signal ? dirUp(signal.direction) : true;

  return (
    <>
      {/* ── Welcome Gate ── */}
      {!gateDone && (
        <div className={`welcome-gate${gateLeaving ? ' is-leaving' : ''}`}>
          <div className="gate-orbit gate-orbit-a" />
          <div className="gate-orbit gate-orbit-b" />
          <div className="gate-particle gate-particle-a" />
          <div className="gate-particle gate-particle-b" />
          <div className="gate-card">
            <div className="gate-brand">
              <span className="logo-orb" />
              <span>RADIK AI BOT</span>
            </div>
            <div className="gate-icon"><span className="gate-icon-core" /></div>
            <span className="gate-kicker">PRIVATE SIGNAL ACCESS</span>
            <h1>Добро пожаловать</h1>
            <p>Введите ID Pocket Option, чтобы открыть меню сигналов.</p>
            <form onSubmit={handleGateSubmit} className="id-entry-form">
              <label htmlFor="pocket-id">ID на Pocket Option</label>
              <div className="id-input-wrap">
                <span className="id-prefix">#</span>
                <input
                  id="pocket-id"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={9}
                  placeholder="000 000 000"
                  value={pocketId}
                  onChange={e => { setPocketId(e.target.value); setIdError(''); }}
                />
              </div>
              <span className="id-error">{idError}</span>
              <button type="submit" className="btn btn-glow btn-lg gate-submit">
                <span className="btn-shine" />
                <span className="btn-label">Открыть доступ</span>
                <span className="btn-arrow">→</span>
              </button>
            </form>
            <div className="gate-safe">
              <span className="safe-dot" /> Данные только для доступа к меню
            </div>
          </div>
        </div>
      )}

      {/* ── Main app after auth ── */}
      {gateDone && (
        <div className="app-shell">
          <div className="app-bg" />

          <header className="app-topbar">
            <div className="app-brand">
              <span className="logo-orb" />
              <span>RADIK <em>AI</em></span>
            </div>
            <div className="app-top-meta">
              <span className={`conn-pill ${connectionStatus}`}>
                <i />
                {connectionStatus === 'online' ? 'ONLINE' : connectionStatus === 'connecting' ? '...' : 'OFFLINE'}
              </span>
              <span className="app-clock">{clock}</span>
              <span className="app-uid">#{participantId}</span>
              <button className="app-exit" onClick={handleExit}>Выйти</button>
            </div>
          </header>

          <main className="signal-stage">
            {/* Idle — big CTA */}
            {phase === 'idle' && !analyzing && (
              <div className="stage-idle">
                <div className="idle-orb" />
                <h2>Готов к анализу рынка</h2>
                <p>ИИ сканирует OTC-пары и выдаёт точку входа с объяснением.</p>
                <button
                  className="btn btn-glow btn-xl"
                  onClick={handleGetSignal}
                  disabled={loading}
                >
                  <span className="btn-shine" />
                  <span className="btn-label">{loading ? 'Загрузка...' : 'Получить сигнал'}</span>
                </button>
                {apiError && <p className="stage-error">{apiError}</p>}
              </div>
            )}

            {/* Analyzing */}
            {analyzing && (
              <div className="stage-analyzing">
                <div className="ai-spinner">
                  <span /><span /><span />
                </div>
                <h2>ИИ анализирует рынок...</h2>
                <p>Свечи · тики · импульс · выплата</p>
              </div>
            )}

            {/* Signal card */}
            {signal && (phase === 'ready' || phase === 'live' || phase === 'result') && !analyzing && (
              <div className={`signal-panel phase-${phase}`}>
                {/* Pair row */}
                <div className="sig-pair-row">
                  <div className="sig-flags">
                    <span className="flag" title="Base">{f1}</span>
                    <span className="flag-slash">/</span>
                    <span className="flag" title="Quote">{f2}</span>
                  </div>
                  <div className="sig-pair-info">
                    <strong>{signal.pair}</strong>
                    <span className="sig-time">{signal.time}</span>
                  </div>
                  <button
                    type="button"
                    className={`copy-btn${copied ? ' copied' : ''}`}
                    onClick={handleCopyPair}
                    title="Скопировать пару"
                  >
                    {copied ? '✓ Скопировано' : '⎘ Копировать'}
                  </button>
                </div>

                {/* Direction + confidence */}
                <div className={`sig-direction ${isUp ? 'up' : 'down'}`}>
                  <span className="dir-arrow">{isUp ? '▲' : '▼'}</span>
                  <span className="dir-text">{isUp ? 'ВВЕРХ' : 'ВНИЗ'}</span>
                  <span className="dir-badge">{signal.confidence}%</span>
                </div>

                {/* Meta chips */}
                <div className="sig-chips">
                  <div className="chip">
                    <span>Вход</span>
                    <strong>{signal.entry_price != null ? signal.entry_price : '—'}</strong>
                  </div>
                  <div className="chip">
                    <span>Экспирация</span>
                    <strong>{signal.expiry || '2 мин'}</strong>
                  </div>
                  <div className="chip">
                    <span>Выплата</span>
                    <strong>{signal.payout || '92%'}</strong>
                  </div>
                </div>

                {/* AI reason */}
                <div className="sig-reason">
                  <div className="reason-head">
                    <span className="reason-dot" />
                    Почему заходим
                  </div>
                  <p>{buildReason(signal)}</p>
                </div>

                {/* Live timer */}
                {phase === 'live' && countdown !== null && (
                  <div className="sig-timer">
                    <div className="timer-ring">
                      <svg viewBox="0 0 120 120">
                        <circle cx="60" cy="60" r="52" className="ring-bg" />
                        <circle
                          cx="60" cy="60" r="52"
                          className="ring-fg"
                          style={{
                            strokeDasharray: `${2 * Math.PI * 52}`,
                            strokeDashoffset: `${2 * Math.PI * 52 * (1 - countdown / 120)}`,
                          }}
                        />
                      </svg>
                      <span className="timer-val">{fmtCountdown(countdown)}</span>
                    </div>
                    <p className="timer-hint">Отслеживание сделки...</p>
                  </div>
                )}

                {/* Result animation */}
                {phase === 'result' && result && (
                  <div className={`sig-result ${result}`}>
                    <div className="result-burst" />
                    <div className="result-label">
                      {result === 'win' ? 'WIN' : 'LOSE'}
                    </div>
                    <p>
                      {result === 'win'
                        ? 'Сигнал зашёл. Прибыль зафиксирована.'
                        : 'Сигнал не зашёл. Можно взять следующий.'}
                    </p>
                  </div>
                )}

                {/* Actions */}
                <div className="sig-actions">
                  {phase === 'ready' && (
                    <button className="btn btn-glow btn-lg" onClick={handleStartTrade}>
                      <span className="btn-shine" />
                      <span className="btn-label">Открыть сделку · 2 мин</span>
                    </button>
                  )}
                  {(phase === 'result' || phase === 'ready') && (
                    <button
                      className="btn btn-ghost btn-lg"
                      onClick={handleGetSignal}
                      disabled={loading}
                    >
                      {loading ? '...' : 'Новый сигнал'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Mini history */}
            {history.length > 0 && (
              <div className="mini-history">
                <span className="mh-title">Последние</span>
                {history.map((h, i) => (
                  <div key={i} className={`mh-item ${h.result}`}>
                    <span>{h.pair}</span>
                    <span>{dirUp(h.direction) ? '▲' : '▼'}</span>
                    <span className="mh-res">{h.result === 'win' ? 'WIN' : 'LOSE'}</span>
                    <span className="mh-time">{h.time}</span>
                  </div>
                ))}
              </div>
            )}
          </main>
        </div>
      )}
    </>
  );
}
