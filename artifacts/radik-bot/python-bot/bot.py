#!/usr/bin/env python3
"""
RADIK AI BOT — реальное подключение к Pocket Option через WebSocket (SSID).

Поддерживает оба формата SSID:
  1) Классический:  42["auth",{"session":"...","isDemo":1,"uid":123,"platform":2}]
  2) Новый:         42["auth",{"sessionToken":"...","uid":"...","lang":"uk",...}]

Запуск:
    pip install -r requirements.txt
    python bot.py
"""

import os
import sys
import re
import json
import time
import logging
import threading
import statistics
from typing import Optional, Tuple

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
import requests

load_dotenv()

# ─── Логирование ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("radik-bot")

# ─── Конфиг ───────────────────────────────────────────────────────────────────
RAW_SSID = os.getenv("POCKET_SSID", "").strip()
DEMO = os.getenv("POCKET_DEMO", "true").lower() in ("1", "true", "yes")
API_PORT = int(os.getenv("API_PORT", "8765"))


def normalize_ssid(raw: str, is_demo: bool) -> Tuple[str, dict]:
    """
    Приводит любой формат auth-сообщения к виду, который понимает PocketOptionAPI-v2:
    42["auth",{"session":"...","isDemo":0|1,"uid":123,"platform":2}]
    """
    if not raw:
        raise ValueError("POCKET_SSID пустой")

    # Вытащить JSON-часть из 42["auth",{...}] или просто {...}
    m = re.search(r'42\s*\[\s*"auth"\s*,\s*(\{.*\})\s*\]', raw, re.DOTALL)
    if m:
        payload_str = m.group(1)
    else:
        payload_str = raw.strip()
        if not payload_str.startswith("{"):
            raise ValueError(f"Не удалось разобрать SSID: {raw[:80]}...")

    try:
        data = json.loads(payload_str)
    except json.JSONDecodeError as e:
        raise ValueError(f"SSID JSON битый: {e}") from e

    # session / sessionToken
    session = (
        data.get("session")
        or data.get("sessionToken")
        or data.get("token")
        or ""
    )
    if not session:
        raise ValueError("В SSID нет session / sessionToken")

    # uid
    uid_raw = data.get("uid") or data.get("user_id") or 0
    try:
        uid = int(uid_raw)
    except (TypeError, ValueError):
        uid = 0

    # isDemo
    if "isDemo" in data:
        is_demo_flag = int(bool(data["isDemo"]))
    else:
        is_demo_flag = 1 if is_demo else 0

    platform = int(data.get("platform") or 2)

    normalized = {
        "session": str(session),
        "isDemo": is_demo_flag,
        "uid": uid,
        "platform": platform,
    }

    for extra in ("lang", "currentUrl", "isChart", "isFastHistory", "isOptimized"):
        if extra in data:
            normalized[extra] = data[extra]
    # defaults that help auth on newer PO servers
    normalized.setdefault("isFastHistory", True)
    normalized.setdefault("isOptimized", True)

    ssid_str = '42["auth",' + json.dumps(normalized, separators=(",", ":")) + "]"
    return ssid_str, normalized


# Нормализуем сразу
try:
    SSID, SSID_META = normalize_ssid(RAW_SSID, DEMO)
    log.info("SSID нормализован: uid=%s isDemo=%s session=%s...",
             SSID_META["uid"], SSID_META["isDemo"], SSID_META["session"][:12])
except ValueError as e:
    log.error("❌ %s", e)
    log.error(
        "Нужна строка вида:\n"
        '  42["auth",{"session":"...","isDemo":1,"uid":123,"platform":2}]\n'
        "или\n"
        '  42["auth",{"sessionToken":"...","uid":"..."}]'
    )
    sys.exit(1)

# ─── PocketOption API ─────────────────────────────────────────────────────────
try:
    from pocketoptionapi.stable_api import PocketOption
    from pocketoptionapi import global_value
except ImportError:
    log.error(
        "Библиотека PocketOptionAPI-v2 не установлена.\n"
        "Выполни: pip install git+https://github.com/Mastaaa1987/PocketOptionAPI-v2.git"
    )
    sys.exit(1)

api: Optional[PocketOption] = None
connected = False
last_balance: Optional[float] = None
last_error: Optional[str] = None
signal_lock = threading.Lock()
active_signal: Optional[dict] = None
recovery_count = 0
last_prices: dict[str, float] = {}
OTC_PAIRS = ["EURUSD_otc", "GBPUSD_otc", "USDJPY_otc", "AUDUSD_otc", "USDCAD_otc"]


def _market_snapshot(active: str) -> dict:
    """Fetch recent one-minute candles through the already authenticated WS."""
    if not connected or api is None:
        raise RuntimeError(last_error or "Не подключено")
    if not api.get_candles(active, 60, count=60, count_request=1):
        raise RuntimeError("Не удалось получить свечи")
    market = global_value.pairs.get(active) or {}
    frame = market.get("dataframe")
    if frame is None or len(frame) < 8:
        raise RuntimeError("Недостаточно рыночных данных")
    closes = [float(value) for value in frame["close"].tail(30).tolist()]
    highs = [float(value) for value in frame["high"].tail(30).tolist()]
    lows = [float(value) for value in frame["low"].tail(30).tolist()]
    last_prices[active] = closes[-1]
    return {
        "active": active,
        "price": closes[-1],
        "closes": closes,
        "highs": highs,
        "lows": lows,
        "trend": "up" if closes[-1] >= closes[-5] else "down",
        "volatility": statistics.pstdev(closes[-12:]) if len(closes) >= 12 else 0,
    }


def _cached_price(active: str) -> Optional[float]:
    price = last_prices.get(active)
    if price is not None:
        return price
    market = global_value.pairs.get(active) or {}
    history = market.get("history") or []
    for item in reversed(history):
        if isinstance(item, dict) and item.get("price") is not None:
            return float(item["price"])
    return None


def _gemini_analysis(snapshot: dict, recovery: int = 0) -> dict:
    """Ask Gemini for a structured, non-executing signal explanation."""
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY не настроен")
    prompt = (
        "Ты аналитик краткосрочных бинарных опционов. Это только образовательный "
        "сигнал, сделки не открывай. Проанализируй последние 30 одноминутных свечей "
        "и верни только JSON без markdown: "
        '{"direction":"ВВЕРХ" или "ВНИЗ","confidence":number 0-100,'
        '"reason":"краткое объяснение на русском"}. '
        f"Пара: {snapshot['active']}; текущая цена: {snapshot['price']}; "
        f"тренд: {snapshot['trend']}; волатильность: {snapshot['volatility']}; "
        f"closes: {snapshot['closes']}; recovery_level: {recovery}."
    )
    response = requests.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
        params={"key": key},
        json={"contents": [{"parts": [{"text": prompt}]}],
              "generationConfig": {"responseMimeType": "application/json"}},
        timeout=25,
    )
    response.raise_for_status()
    payload = response.json()
    text = payload["candidates"][0]["content"]["parts"][0]["text"]
    result = json.loads(text)
    direction = result.get("direction")
    if direction not in ("ВВЕРХ", "ВНИЗ"):
        raise ValueError("ИИ вернул недопустимое направление")
    confidence = max(0, min(100, int(result.get("confidence", 0))))
    return {"direction": direction, "confidence": confidence,
            "reason": str(result.get("reason", "Анализ завершён"))}


def connect_ws() -> bool:
    """Подключается к WebSocket Pocket Option по SSID."""
    global api, connected, last_error, last_balance

    try:
        is_demo = bool(SSID_META.get("isDemo", 1))
        log.info("🔌 Подключение к Pocket Option WebSocket (demo=%s, uid=%s)...",
                 is_demo, SSID_META.get("uid"))
        log.info("   SSID: %s", SSID[:70] + "...")

        api = PocketOption(is_demo, SSID)
        result = api.connect()
        log.info("Результат connect(): %s", result)

        time.sleep(2.5)

        balance = None
        for method_name in ("get_balance", "GetBalance", "getbalance"):
            method = getattr(api, method_name, None)
            if callable(method):
                try:
                    balance = method()
                    break
                except Exception:
                    continue

        if balance is not None:
            last_balance = float(balance)
            connected = True
            last_error = None
            log.info("✅ Подключено! Баланс: $%.2f", last_balance)
            return True

        last_error = "Баланс не получен (SSID устарел или формат не принят сервером)"
        connected = False
        log.warning("⚠️ %s", last_error)
        return False

    except Exception as e:
        last_error = str(e)
        connected = False
        log.exception("❌ Ошибка подключения: %s", e)
        return False


def keep_alive():
    """Фоновый поток: периодически проверяет соединение и обновляет баланс."""
    global last_balance, connected, last_error
    while True:
        time.sleep(25)
        if not api:
            continue
        try:
            bal = None
            for method_name in ("get_balance", "GetBalance", "getbalance"):
                method = getattr(api, method_name, None)
                if callable(method):
                    try:
                        bal = method()
                        break
                    except Exception:
                        continue
            if bal is not None:
                last_balance = float(bal)
                connected = True
                last_error = None
            else:
                connected = False
                last_error = "Потеряно соединение"
                log.warning("Переподключение...")
                connect_ws()
        except Exception as e:
            connected = False
            last_error = str(e)
            log.warning("Ошибка keep-alive: %s — переподключаюсь", e)
            connect_ws()


# ─── HTTP API ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)


class ProxyPrefixMiddleware:
    def __init__(self, application):
        self.application = application

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        for prefix in ("/api/bot", "/bot"):
            if path.startswith(prefix):
                environ["PATH_INFO"] = path[len(prefix):] or "/"
                break
        return self.application(environ, start_response)


app.wsgi_app = ProxyPrefixMiddleware(app.wsgi_app)


@app.before_request
def strip_proxy_prefix():
    for prefix in ("/api/bot", "/bot"):
        if request.path.startswith(prefix):
            request.environ["PATH_INFO"] = request.path[len(prefix):] or "/"
            break


@app.route("/signal", methods=["GET"])
def signal():
    """Create a Gemini-backed signal from live Pocket Option candle data."""
    global active_signal, recovery_count
    active = request.args.get("active", OTC_PAIRS[0])
    if active not in OTC_PAIRS:
        return jsonify({"error": "Недопустимая OTC-пара"}), 400
    try:
        with signal_lock:
            snapshot = _market_snapshot(active)
            analysis = _gemini_analysis(snapshot, recovery_count)
            active_signal = {
                "pair": active.replace("_otc", "").replace("USD", "/USD"),
                "raw_pair": active,
                "direction": analysis["direction"],
                "confidence": analysis["confidence"],
                "expiry": "2 мин",
                "payout": "92%",
                "status": "new",
                "entry_price": snapshot["price"],
                "close_price": None,
                "need_overlap": False,
                "overlap_direction": None,
                "recovery_count": recovery_count,
                "reason": analysis["reason"],
                "created_at": time.time(),
            }
            return jsonify(active_signal)
    except Exception as exc:
        log.warning("Ошибка подготовки Gemini-сигнала: %s", type(exc).__name__)
        return jsonify({
            "error": "Gemini временно недоступен или ключ не имеет доступа к модели",
            "ai_available": False,
        }), 503


@app.route("/price/<active>", methods=["GET"])
def price(active: str):
    if active not in OTC_PAIRS:
        return jsonify({"error": "Недопустимая OTC-пара"}), 400
    try:
        current = _cached_price(active)
        if current is None:
            current = _market_snapshot(active)["price"]
        return jsonify({"active": active, "price": current, "time": time.time()})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 503


@app.route("/signal/result", methods=["POST"])
def signal_result():
    """Close the current paper signal and prepare at most two recoveries."""
    global active_signal, recovery_count
    if not active_signal:
        return jsonify({"error": "Нет активного сигнала"}), 400
    data = request.get_json(force=True) or {}
    entry_price = float(data.get("entry_price") or active_signal["entry_price"])
    close_price = float(data.get("close_price") or 0)
    if not close_price:
        close_price = _cached_price(active_signal["raw_pair"])
    if close_price is None:
        return jsonify({"error": "Цена закрытия ещё не получена"}), 503
    up = active_signal["direction"] == "ВВЕРХ"
    won = close_price > entry_price if up else close_price < entry_price
    if close_price == entry_price:
        won = False
    active_signal["entry_price"] = entry_price
    active_signal["close_price"] = close_price
    active_signal["status"] = "won" if won else "lost"
    if won:
        active_signal["need_overlap"] = False
        active_signal["message"] = "Сигнал зашёл. Перекрытие не нужно."
        recovery_count = 0
    elif recovery_count < 2:
        recovery_count += 1
        active_signal["need_overlap"] = True
        active_signal["overlap_direction"] = "ВНИЗ" if up else "ВВЕРХ"
        active_signal["message"] = f"Сигнал не зашёл. Доступно перекрытие {recovery_count}/2."
    else:
        active_signal["need_overlap"] = False
        active_signal["message"] = "Лимит перекрытий 2/2 достигнут. Ожидание нового сигнала."
        recovery_count = 0
    return jsonify(active_signal)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok" if connected else "error",
        "ssid_loaded": True,
        "ssid_format": "sessionToken" if "sessionToken" in RAW_SSID else "session",
        "uid": SSID_META.get("uid"),
        "demo": bool(SSID_META.get("isDemo", 1)),
        "connected": connected,
        "ai_available": bool(os.getenv("GEMINI_API_KEY", "").strip()),
        "balance": last_balance,
        "error": last_error,
    })


@app.route("/balance", methods=["GET"])
def balance():
    if not connected or api is None:
        return jsonify({"error": last_error or "Не подключено"}), 503
    try:
        bal = None
        for method_name in ("get_balance", "GetBalance", "getbalance"):
            method = getattr(api, method_name, None)
            if callable(method):
                try:
                    bal = method()
                    break
                except Exception:
                    continue
        return jsonify({"balance": float(bal) if bal is not None else None})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/buy", methods=["POST"])
def buy():
    """
    Body: {"active": "EURUSD_otc", "direction": "call", "amount": 1, "duration": 60}
    direction: call = ВВЕРХ, put = ВНИЗ
    """
    if not connected or api is None:
        return jsonify({"error": last_error or "Не подключено"}), 503

    data = request.get_json(force=True) or {}
    active = data.get("active", "EURUSD_otc")
    direction = data.get("direction", "call")
    amount = float(data.get("amount", 1))
    duration = int(data.get("duration", 60))

    try:
        result = api.buy(active=active, direction=direction, amount=amount, duration=duration)
        return jsonify({"ok": True, "result": result})
    except TypeError:
        try:
            status, order_id = api.Buy(amount, active, direction, duration)
            return jsonify({"ok": bool(status), "order_id": order_id})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/ssid", methods=["GET"])
def show_ssid_meta():
    """Показать нормализованные поля SSID (без полного session)."""
    return jsonify({
        "uid": SSID_META.get("uid"),
        "isDemo": SSID_META.get("isDemo"),
        "platform": SSID_META.get("platform"),
        "session_preview": (SSID_META.get("session") or "")[:16] + "...",
        "raw_had_sessionToken": "sessionToken" in RAW_SSID,
    })


def main():
    log.info("=" * 60)
    log.info("RADIK AI BOT — WebSocket Pocket Option")
    log.info("Demo mode : %s", bool(SSID_META.get("isDemo")))
    log.info("UID       : %s", SSID_META.get("uid"))
    log.info("Session   : %s...", (SSID_META.get("session") or "")[:16])
    log.info("=" * 60)

    if not connect_ws():
        log.error("Не удалось подключиться. Проверь SSID и интернет.")
        log.error("Если SSID в формате sessionToken — библиотека может его не принять.")
        log.error("Тогда возьми классический SSID из WS-сообщения с полем \"session\".")
    else:
        t = threading.Thread(target=keep_alive, daemon=True)
        t.start()

    log.info("🌐 HTTP API: http://0.0.0.0:%s", API_PORT)
    log.info("   GET  /health")
    log.info("   GET  /balance")
    log.info("   GET  /ssid")
    log.info("   POST /buy")
    app.run(host="0.0.0.0", port=API_PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
