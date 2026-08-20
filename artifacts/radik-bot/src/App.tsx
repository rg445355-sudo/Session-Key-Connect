import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

const API_HEADERS = { 'Content-Type': 'application/json' };

type ConnectionStatus = 'connecting' | 'online' | 'offline';
type Phase = 'idle' | 'ready' | 'live' | 'result';
type Outcome = 'win' | 'lose';

type Signal = {
  id?: string | number;
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

type BackendResult = {
  outcome: Outcome | null;
  closePrice: number | null;
  recoveryCount: number;
  message: string;
};

type HistoryItem = {
  pair: string;
  direction: string;
  result: Outcome;
  time: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unwrapPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (isRecord(value.data)) return value.data;
  if (isRecord(value.signal)) return value.signal;
  if (isRecord(value.result)) return value.result;
  return value;
}

function textValue(value: unknown, fallback = '') {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isAiUnavailable(value: unknown) {
  const payloads = [value, unwrapPayload(value)];
  return payloads.some(candidate => {
    const payload = isRecord(candidate) ? candidate : {};
    const status = textValue(payload.status).toLowerCase();
    const error = textValue(payload.error).toLowerCase();
    const message = textValue(payload.message).toLowerCase();
    return payload.ai_available === false
      || payload.aiAvailable === false
      || payload.available === false
      || status.includes('unavailable')
      || error.includes('ai unavailable')
      || message.includes('ai unavailable')
      || message.includes('ии недоступ');
  });
}

function errorText(value: unknown, fallback: string) {
  const payload = unwrapPayload(value);
  const detail = payload.detail || payload.error || payload.message;
  return textValue(detail, fallback);
}

async function apiGet(path: string, params?: Record<string, string>) {
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  const response = await fetch(`${path}${query}`, { headers: API_HEADERS });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(errorText(payload, `Ошибка сервера: ${response.status}`));
    if (isAiUnavailable(payload)) error.name = 'AI_UNAVAILABLE';
    throw error;
  }
  return payload;
}

async function apiPost(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: 'POST',
    headers: API_HEADERS,
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(errorText(payload, `Ошибка сервера: ${response.status}`));
    if (isAiUnavailable(payload)) error.name = 'AI_UNAVAILABLE';
    throw error;
  }
  return payload;
}

function formatTime(date: Date) {
  return `${date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Moscow',
  })} MSK`;
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function directionIsUp(direction: string) {
  const normalized = direction.toLowerCase();
  return normalized === 'вверх' || normalized === 'up' || normalized === 'call' || normalized === 'buy';
}

function directionLabel(direction: string) {
  return directionIsUp(direction) ? 'ВВЕРХ' : 'ВНИЗ';
}

function marketCodes(pair: string): [string, string] {
  const parts = pair.replace(/\s/g, '').replace(/_otc$/i, '').split('/');
  if (parts.length === 2) return [parts[0], parts[1]];
  const raw = pair.replace(/_otc$/i, '').replace(/[^a-z]/gi, '').toUpperCase();
  return [raw.slice(0, 3) || 'FX', raw.slice(3, 6) || 'OTC'];
}

function normalizeSignal(value: unknown): Signal {
  const payload = unwrapPayload(value);
  const pair = textValue(payload.pair || payload.symbol);
  const direction = textValue(payload.direction || payload.signal);
  if (!pair || !direction) {
    throw new Error('Сервер не вернул полный сигнал');
  }
  return {
    id: typeof payload.id === 'string' || typeof payload.id === 'number' ? payload.id : undefined,
    pair,
    direction,
    confidence: numberValue(payload.confidence) ?? 0,
    expiry: textValue(payload.expiry || payload.expiration, '2 мин'),
    payout: textValue(payload.payout, '—'),
    time: textValue(payload.time || payload.created_at, formatTime(new Date())),
    status: textValue(payload.status, 'ready'),
    entry_price: numberValue(payload.entry_price ?? payload.entryPrice),
    message: textValue(payload.message),
    reason: textValue(payload.reason || payload.explanation),
  };
}

function normalizeOutcome(value: unknown): Outcome | null {
  if (typeof value === 'boolean') return value ? 'win' : 'lose';
  const normalized = textValue(value).toLowerCase();
  if (['win', 'won', 'winner', 'profit', 'success', 'выигрыш', 'победа'].includes(normalized)) return 'win';
  if (['lose', 'loss', 'lost', 'loser', 'fail', 'failed', 'убыток', 'поражение'].includes(normalized)) return 'lose';
  return null;
}

function normalizeResult(value: unknown): BackendResult {
  const payload = unwrapPayload(value);
  const outcome = normalizeOutcome(payload.won ?? payload.outcome ?? payload.result ?? payload.win_loss ?? payload.status);
  const recovery = numberValue(payload.recovery_count ?? payload.recoveryCount) ?? 0;
  return {
    outcome,
    closePrice: numberValue(payload.close_price ?? payload.closePrice ?? payload.final_close_price ?? payload.final_price),
    recoveryCount: Math.max(0, Math.min(2, Math.trunc(recovery))),
    message: textValue(payload.message),
  };
}

export default function App() {
  const [gateLeaving, setGateLeaving] = useState(false);
  const [gateDone, setGateDone] = useState(false);
  const [pocketId, setPocketId] = useState('');
  const [idError, setIdError] = useState('');
  const [participantId, setParticipantId] = useState('');

  const [clock, setClock] = useState(() => formatTime(new Date()));
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [result, setResult] = useState<Outcome | null>(null);
  const [resultPending, setResultPending] = useState(false);
  const [closePrice, setClosePrice] = useState<number | null>(null);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [apiError, setApiError] = useState('');
  const [resultError, setResultError] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const timerEndRef = useRef<number | null>(null);
  const entryRef = useRef<number | null>(null);
  const resultRequestedRef = useRef(false);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(formatTime(new Date())), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const checkHealth = useCallback(async () => {
    setConnectionStatus('connecting');
    try {
      const payload = await apiGet('/api/bot/health');
      setConnectionStatus('online');
      const data = unwrapPayload(payload);
      setAiAvailable(isAiUnavailable(payload) ? false : data.ai_available === false || data.aiAvailable === false ? false : true);
    } catch {
      setConnectionStatus('offline');
      setAiAvailable(null);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const finishSignal = useCallback(async () => {
    if (!signal || phase === 'result' || resultRequestedRef.current) return;
    resultRequestedRef.current = true;
    setPhase('result');
    setCountdown(null);
    setResult(null);
    setClosePrice(null);
    setResultError('');
    setResultPending(true);

    try {
      const payload = await apiPost('/api/bot/signal/result', {
        participant_id: participantId,
        signal_id: signal.id ?? null,
        pair: signal.pair,
        direction: signal.direction,
        entry_price: entryRef.current,
        started_at: timerEndRef.current ? new Date(timerEndRef.current - 120000).toISOString() : null,
      });
      const resolved = normalizeResult(payload);
      setClosePrice(resolved.closePrice);
      setRecoveryCount(resolved.recoveryCount);
      if (!resolved.outcome) {
        setResultError(resolved.message || 'Сервер не вернул итог сделки. Результат не определён.');
        return;
      }
      setResult(resolved.outcome);
      setHistory(items => [
        {
          pair: signal.pair,
          direction: signal.direction,
          result: resolved.outcome as Outcome,
          time: formatTime(new Date()).replace(' MSK', ''),
        },
        ...items.slice(0, 7),
      ]);
    } catch (error) {
      setResultError(error instanceof Error ? error.message : 'Не удалось получить итог сигнала');
    } finally {
      setResultPending(false);
    }
  }, [participantId, phase, signal]);

  useEffect(() => {
    if (countdown === null || phase !== 'live') return;
    if (countdown <= 0) {
      void finishSignal();
      return;
    }
    const timeout = window.setTimeout(() => {
      const end = timerEndRef.current;
      const remaining = end ? Math.max(0, Math.ceil((end - Date.now()) / 1000)) : countdown - 1;
      setCountdown(remaining);
    }, 1000);
    return () => window.clearTimeout(timeout);
  }, [countdown, finishSignal, phase]);

  const handleGateSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = pocketId.replace(/\D/g, '');
    if (cleaned.length < 6) {
      setIdError('Введите корректный ID (минимум 6 цифр)');
      return;
    }
    setIdError('');
    setParticipantId(cleaned);
    setGateLeaving(true);
    window.setTimeout(() => setGateDone(true), 720);
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
    setResultPending(false);
    setClosePrice(null);
    setRecoveryCount(0);
    setApiError('');
    setResultError('');
    resultRequestedRef.current = false;
  }, []);

  const handleGetSignal = useCallback(async () => {
    setLoading(true);
    setAnalyzing(true);
    setApiError('');
    setResultError('');
    setResult(null);
    setSignal(null);
    setPhase('idle');
    setCountdown(null);
    setClosePrice(null);
    setRecoveryCount(0);
    resultRequestedRef.current = false;

    try {
      await new Promise(resolve => window.setTimeout(resolve, 500));
      const payload = await apiGet('/api/bot/signal', { participant_id: participantId });
      if (isAiUnavailable(payload)) {
        setAiAvailable(false);
        throw new Error('ИИ сейчас недоступен. Сигнал не сформирован. Попробуйте позже.');
      }
      const received = normalizeSignal(payload);
      setSignal(received);
      setAiAvailable(true);
      setPhase('ready');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось получить сигнал';
      setApiError(error instanceof Error && error.name === 'AI_UNAVAILABLE'
        ? 'ИИ сейчас недоступен. Сигнал не сформирован. Попробуйте позже.'
        : message);
      setPhase('idle');
    } finally {
      setAnalyzing(false);
      setLoading(false);
    }
  }, [participantId]);

  const handleStartTracking = useCallback(() => {
    if (!signal || signal.entry_price === null) {
      setApiError('Для отслеживания сервер должен вернуть цену входа.');
      return;
    }
    entryRef.current = signal.entry_price;
    timerEndRef.current = Date.now() + 120000;
    resultRequestedRef.current = false;
    setPhase('live');
    setCountdown(120);
    setResult(null);
    setClosePrice(null);
    setResultError('');
  }, [signal]);

  const handleCopyPair = useCallback(async () => {
    if (!signal) return;
    try {
      await navigator.clipboard.writeText(signal.pair);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = signal.pair;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }, [signal]);

  const [baseCode, quoteCode] = signal ? marketCodes(signal.pair) : ['FX', 'OTC'];
  const isUp = signal ? directionIsUp(signal.direction) : true;
  const reason = signal?.reason || signal?.message;

  return (
    <>
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
                  data-testid="input-pocket-id"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={9}
                  placeholder="000 000 000"
                  value={pocketId}
                  onChange={event => { setPocketId(event.target.value); setIdError(''); }}
                />
              </div>
              <span className="id-error" data-testid="text-id-error">{idError}</span>
              <button type="submit" data-testid="button-open-access" className="btn btn-glow btn-lg gate-submit">
                <span className="btn-shine" />
                <span className="btn-label">Открыть доступ</span>
              </button>
            </form>
            <div className="gate-safe">
              <span className="safe-dot" /> Данные только для доступа к меню
            </div>
          </div>
        </div>
      )}

      {gateDone && (
        <div className="app-shell">
          <div className="app-bg" />
          <header className="app-topbar">
            <div className="app-brand">
              <span className="logo-orb" />
              <span>RADIK <em>AI</em></span>
            </div>
            <div className="app-top-meta">
              <span className={`conn-pill ${connectionStatus}`} data-testid="status-connection">
                <i />
                {connectionStatus === 'online' ? 'ONLINE' : connectionStatus === 'connecting' ? 'CONNECTING' : 'OFFLINE'}
              </span>
              <span className={`ai-pill${aiAvailable === false ? ' unavailable' : ''}`} data-testid="status-ai">
                {aiAvailable === false ? 'AI UNAVAILABLE' : aiAvailable === null ? 'AI CHECK' : 'AI READY'}
              </span>
              <span className="app-clock">{clock}</span>
              <span className="app-uid">#{participantId}</span>
              <button className="app-exit" data-testid="button-exit" onClick={handleExit}>Выйти</button>
            </div>
          </header>

          <main className="signal-stage">
            {phase === 'idle' && !analyzing && (
              <div className="stage-idle">
                <div className="idle-orb" />
                <h2>Готов к анализу рынка</h2>
                <p>ИИ сканирует OTC-пары и выдаёт точку входа с объяснением.</p>
                <button
                  className="btn btn-glow btn-xl"
                  data-testid="button-get-signal"
                  onClick={() => void handleGetSignal()}
                  disabled={loading}
                >
                  <span className="btn-shine" />
                  <span className="btn-label">{loading ? 'Загрузка...' : 'Получить сигнал'}</span>
                </button>
                <div className="connection-note">
                  <span className={`connection-note-dot ${connectionStatus}`} />
                  Соединение: {connectionStatus === 'online' ? 'сервер подключён' : connectionStatus === 'connecting' ? 'проверка сервера' : 'сервер недоступен'}
                </div>
                {aiAvailable === false && <p className="stage-error" data-testid="error-ai-unavailable">ИИ сейчас недоступен. Сигнал не сформирован.</p>}
                {apiError && <p className="stage-error" data-testid="error-signal">{apiError}</p>}
              </div>
            )}

            {analyzing && (
              <div className="stage-analyzing" data-testid="status-analyzing">
                <div className="ai-spinner"><span /><span /><span /></div>
                <h2>ИИ анализирует рынок...</h2>
                <p>Свечи · тики · импульс · выплата</p>
              </div>
            )}

            {signal && (phase === 'ready' || phase === 'live' || phase === 'result') && !analyzing && (
              <div className={`signal-panel phase-${phase}`}>
                <div className="sig-pair-row">
                  <div className="sig-flags" aria-label={`Валюты ${baseCode} и ${quoteCode}`}>
                    <span className="currency-code">{baseCode}</span>
                    <span className="flag-slash">/</span>
                    <span className="currency-code">{quoteCode}</span>
                  </div>
                  <div className="sig-pair-info">
                    <strong data-testid="text-pair">{signal.pair}</strong>
                    <span className="sig-time">{signal.time}</span>
                  </div>
                  <button
                    type="button"
                    data-testid="button-copy-pair"
                    className={`copy-btn${copied ? ' copied' : ''}`}
                    onClick={() => void handleCopyPair()}
                    title="Скопировать пару"
                  >
                    {copied ? 'Скопировано' : 'Копировать'}
                  </button>
                </div>

                <div className={`sig-direction ${isUp ? 'up' : 'down'}`} data-testid="text-direction">
                  <span className="dir-arrow">{isUp ? 'UP' : 'DOWN'}</span>
                  <span className="dir-text">{directionLabel(signal.direction)}</span>
                  <span className="dir-badge" data-testid="text-confidence">{signal.confidence}%</span>
                </div>

                <div className="sig-chips">
                  <div className="chip">
                    <span>Вход</span>
                    <strong data-testid="text-entry-price">{signal.entry_price !== null ? signal.entry_price : '—'}</strong>
                  </div>
                  <div className="chip">
                    <span>Экспирация</span>
                    <strong>{signal.expiry}</strong>
                  </div>
                  <div className="chip">
                    <span>Выплата</span>
                    <strong>{signal.payout}</strong>
                  </div>
                  <div className="chip recovery-chip">
                    <span>Восстановление</span>
                    <strong data-testid="text-recovery-count">{recoveryCount} / 2</strong>
                  </div>
                </div>

                <div className="sig-reason">
                  <div className="reason-head"><span className="reason-dot" /> Почему заходим</div>
                  <p>{reason || 'Пояснение от модели не передано сервером.'}</p>
                </div>

                <div className="no-trade-note">Сделки не открываются автоматически. Нажмите кнопку только после ручного действия на платформе.</div>

                {phase === 'live' && countdown !== null && (
                  <div className="sig-timer" data-testid="status-countdown">
                    <div className="timer-ring">
                      <svg viewBox="0 0 120 120" aria-hidden="true">
                        <circle cx="60" cy="60" r="52" className="ring-bg" />
                        <circle
                          cx="60"
                          cy="60"
                          r="52"
                          className="ring-fg"
                          style={{
                            strokeDasharray: `${2 * Math.PI * 52}`,
                            strokeDashoffset: `${2 * Math.PI * 52 * (1 - countdown / 120)}`,
                          }}
                        />
                      </svg>
                      <span className="timer-val">{formatCountdown(countdown)}</span>
                    </div>
                    <p className="timer-hint">Отслеживание сигнала · 2 минуты</p>
                  </div>
                )}

                {phase === 'result' && (
                  <div className={`sig-result ${result || 'neutral'}`} data-testid="status-result">
                    <div className="result-burst" />
                    {resultPending ? (
                      <>
                        <div className="result-label">ОЖИДАНИЕ</div>
                        <p>Запрашиваем финальную цену у сервера...</p>
                      </>
                    ) : result ? (
                      <>
                        <div className="result-label">{result === 'win' ? 'WIN' : 'LOSE'}</div>
                        <p>{result === 'win' ? 'Сигнал зашёл. Итог подтверждён сервером.' : 'Сигнал не зашёл. Итог подтверждён сервером.'}</p>
                      </>
                    ) : (
                      <>
                        <div className="result-label">НЕТ ИТОГА</div>
                        <p>{resultError || 'Сервер не вернул итог сигнала.'}</p>
                      </>
                    )}
                    <div className="result-details">
                      <span>Финальная цена</span>
                      <strong data-testid="text-close-price">{closePrice !== null ? closePrice : '—'}</strong>
                    </div>
                    <div className="result-details">
                      <span>Восстановление</span>
                      <strong data-testid="text-result-recovery">{recoveryCount} / 2</strong>
                    </div>
                    {resultError && !resultPending && <p className="result-error" data-testid="error-result">{resultError}</p>}
                  </div>
                )}

                <div className="sig-actions">
                  {phase === 'ready' && (
                    <button className="btn btn-glow btn-lg" data-testid="button-start-tracking" onClick={handleStartTracking}>
                      <span className="btn-shine" />
                      <span className="btn-label">Начать отслеживание · 2 мин</span>
                    </button>
                  )}
                  {(phase === 'result' || phase === 'ready') && (
                    <button
                      className="btn btn-ghost btn-lg"
                      data-testid="button-new-signal"
                      onClick={() => void handleGetSignal()}
                      disabled={loading || resultPending}
                    >
                      {loading ? 'Загрузка...' : 'Новый сигнал'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {history.length > 0 && (
              <div className="mini-history">
                <span className="mh-title">Последние результаты</span>
                {history.map((item, index) => (
                  <div key={`${item.pair}-${item.time}-${index}`} className={`mh-item ${item.result}`} data-testid={`row-history-${index}`}>
                    <span>{item.pair}</span>
                    <span className="history-direction">{directionLabel(item.direction)}</span>
                    <span className="mh-res">{item.result === 'win' ? 'WIN' : 'LOSE'}</span>
                    <span className="mh-time">{item.time}</span>
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