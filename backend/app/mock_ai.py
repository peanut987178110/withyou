"""Deterministic, offline reply engine + safety classifier + memory extraction.

The production system calls a hosted model. This module is the documented
`WITHYOU_AI_MODE=mock` fallback: same contract (reply_text, interaction_mode,
memory_proposals), no network, no API key, reproducible for tests.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

from . import content, locales

_HIGH_RISK = [
    r"\bkill myself\b", r"\bkill my self\b", r"\bend my life\b", r"\bwant to die\b",
    r"\bwanna die\b", r"\bsuicidal\b", r"\bsuicide\b", r"\bhurt myself\b",
    r"\bself[- ]?harm\b", r"\bcut myself\b", r"\bno reason to live\b",
    r"\bbetter off dead\b", r"\boverdose\b", r"\bhang myself\b",
    r"\bi have a plan\b", r"\bdon't want to be here anymore\b",
    # Chinese (both scripts)
    r"想死", r"去死", r"不想活", r"活不下去", r"自殺", r"自杀", r"結束生命", r"结束生命",
    r"傷害自己", r"伤害自己", r"割腕", r"遗书", r"遺書",
    # Japanese
    r"死にたい", r"消えたい", r"自殺", r"リストカット", r"終わりにしたい",
    # Korean
    r"죽고 ?싶", r"죽어야", r"자살", r"자해", r"살기 ?싫",
    # Spanish / Portuguese / French / German
    r"quiero morir", r"matarme", r"quitarme la vida", r"suicid",
    r"quero morrer", r"me matar", r"tirar minha vida",
    r"je veux mourir", r"me suicider", r"en finir avec la vie",
    r"ich will sterben", r"mich umbringen", r"suizid",
    # Arabic
    r"أريد أن أموت", r"اريد ان اموت", r"أنهي حياتي", r"انهي حياتي", r"أؤذي نفسي", r"انتحار",
]
_VIOLENCE = [
    r"\bhow (?:do|can|to) (?:i )?(?:kill|hurt|poison|stab|shoot)\b",
    r"\bmake (?:a )?bomb\b", r"\bbuild (?:a )?weapon\b", r"\bhurt someone\b",
    r"\bkill (?:him|her|them|someone|people)\b",
    r"怎么(?:杀|杀死|伤害|毒死)", r"怎麼(?:殺|殺死|傷害|毒死)", r"做炸弹", r"做炸彈",
    r"人を殺す方法", r"爆弾の作り方", r"사람을 죽이는", r"폭탄 만드는",
    r"cómo (?:matar|herir) a alguien", r"bomba caseira", r"comment tuer quelqu'un",
    r"wie (?:ich )?jemanden töte", r"كيف أقتل",
]
_INJECTION = [
    r"ignore (?:all )?(?:the )?previous instructions", r"ignore your (?:system )?prompt",
    r"system prompt", r"reveal (?:your )?instructions", r"print (?:your )?prompt",
    r"developer mode", r"jailbreak", r"\byou are now\b", r"pretend you are",
    r"act as (?:an? )?(?:unrestricted|uncensored)",
    r"忽略(?:之前|以上|前面)的指令", r"系統提示", r"系统提示",
    r"前の指示を無視", r"システムプロンプト", r"이전 지시를 무시", r"시스템 프롬프트",
    r"ignora las instrucciones anteriores", r"ignorer les instructions précédentes",
    r"ignoriere die vorherigen anweisungen", r"تجاهل التعليمات",
]
_SENSITIVE = [
    r"medicat", r"diagnos", r"therapy", r"therapist", r"dosage", r"prescription",
    r"hiv", r"cancer", r"pregnan", r"sexual", r"religio", r"politic",
    r"salary", r"bank account", r"credit card", r"passport", r"social security",
    r"\b\d{5,}\b", r"@\w+\.\w+",
    # CJK / Korean / Arabic equivalents that a regex on ASCII would miss
    r"(?:护照|護照|信用卡|銀行賬戶|银行账户|身份证|身份證|社保号|社保號|病历|病歷|诊断|診斷|抑郁症|抑鬱症|怀孕|懷孕|宗教信仰|政治立场|政治立場)",
    r"(?:パスポート|クレジットカード|診断|うつ病|妊娠|宗教|政治)",
    r"(?:여권|신용카드|진단|우울증|임신|종교|정치)",
    r"(?:جواز سفر|بطاقة ائتمان|تشخيص|حامل|دين|سياسة)",
]

_SAD = [
    "sad", "tired", "exhausted", "lonely", "alone", "anxious", "anxiety", "stressed",
    "stress", "overwhelmed", "awful", "terrible", "bad day", "long day", "rough day",
    "cried", "crying", "upset", "worried", "numb", "drained", "burnt out", "burned out",
    "depressed", "hopeless", "miss", "lost", "grief",
]
_HAPPY = [
    "happy", "excited", "proud", "great day", "good day", "amazing", "grateful",
    "relieved", "better today", "feeling good", "went well", "celebrate",
]
_WORK = ["job", "work", "interview", "deadline", "project", "boss", "manager", "office",
         "exam", "study", "class", "school", "career", "promotion", "meeting"]
_REL = ["partner", "boyfriend", "girlfriend", "husband", "wife", "friend", "mom", "dad",
        "mother", "father", "family", "breakup", "broke up", "argument", "fight"]
_SLEEP = ["sleep", "insomnia", "bedtime", "tired", "night", "dream", "awake"]
_CREATIVE = ["story", "game", "play", "imagine", "creative", "write", "draw"]


def _has(patterns: list[str], text: str) -> bool:
    low = text.lower()
    return any(re.search(p, low) for p in patterns)


def _any(words: list[str], low: str) -> bool:
    """Substring match that also works for CJK, where `\\b` never fires."""
    return any(w in low for w in words)


def classify(text: str) -> dict[str, Any]:
    """Input-side safety classification (production: hosted classifier)."""
    low = (text or "").lower().strip()
    if _has(_HIGH_RISK, low):
        return {"level": "S3", "category": "self_harm", "blocked": True}
    if _has(_VIOLENCE, low):
        return {"level": "S3", "category": "violence", "blocked": True}
    if _has(_INJECTION, low):
        return {"level": "S1", "category": "prompt_injection", "blocked": True}
    return {"level": "S0", "category": "none", "blocked": False}


def crisis_resources(region: str | None) -> list[dict[str, str]]:
    region = (region or "").upper()
    return list(content.CRISIS_RESOURCES.get(region, []))


def crisis_reply(category: str, region: str | None, locale: str = "en") -> dict[str, Any]:
    """Crisis / safety reply in the user's language.

    The `category` and `risk_level` stay canonical (English) — that is what the
    safety review queue consumes. Only the text the user reads is localised.
    """
    pk = locales.pack(locale)
    resources = crisis_resources(region)
    if category == "violence":
        body = pk["safety"]["S002"]
    elif category == "prompt_injection":
        body = pk["safety"]["S003"]
    else:
        body = pk["safety"]["S001"]
    lines = [body, pk["crisis_alone"]]
    if resources:
        lines.append(pk["crisis_header"])
        for r in resources:
            lines.append(f"• {r['name']} — {r['contact']} ({r['hours']})")
    else:
        lines.append(pk["crisis_footer"])
    return {
        "reply_text": "\n\n".join(lines),
        "interaction_mode": "safety",
        "memory_proposals": [],
        "resources": resources,
        "risk_level": "S3" if category == "self_harm" else "S1",
        "category": category,
        "locale": locales.normalise(locale),
    }


def _pick(options: list[str], key: str, salt: str = "") -> str:
    idx = int(hashlib.sha256((key + salt).encode("utf-8")).hexdigest(), 16) % len(options)
    return options[idx]


def _fmt_memory(mem: str) -> str:
    # Strip the sentence-final mark in any of the supported scripts ("." / "。" / "．");
    # only lower-case the first letter when it is Latin — 你 must not be touched.
    text = mem.strip().rstrip(".").rstrip("。").rstrip("．").strip()
    if not text:
        return ""
    return text[0].lower() + text[1:] if "a" <= text[0].lower() <= "z" else text


def _tokens(text: str) -> set[str]:
    """Word tokens for Latin scripts, character bigrams for CJK.

    `\\b`-based word matching finds nothing in 中文, 日本語 or 한국어, so the
    retrieval look-up would silently never match a memory written in the
    user's own language. Bigrams are the cheap, script-agnostic stand-in.
    """
    low = (text or "").lower()
    words = set(re.findall(r"[a-z']{4,}", low))
    cjk = re.sub(r"[^぀-ヿ㐀-鿿가-힯]+", " ", low)
    for run in cjk.split():
        if len(run) >= 2:
            words |= {run[i:i + 2] for i in range(len(run) - 1)}
        elif run:
            words.add(run)
    return words


def _relevant_memories(text: str, memories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    words = _tokens(text)
    out = []
    for m in memories:
        if words & _tokens(m.get("text") or ""):
            out.append(m)
    return out


def compose_reply(
    *,
    user_text: str,
    name: str,
    traits: list[str],
    relationship_type: str,
    level: int,
    memories: list[dict[str, Any]],
    retrieval_enabled: bool,
    history: list[dict[str, Any]],
    region: str | None,
    locale: str = "en",
) -> dict[str, Any]:
    """Compose a reply in the user's language.

    Every branch draws its wording from one locale pack, so switching language
    changes the companion's voice without changing its intent detection shape.
    The keyword lists come from the same pack — matching English words against
    a Chinese message would make every branch miss and fall through to default.
    """
    pk = locales.pack(locale)
    kw = pk["keywords"]
    low = user_text.lower().strip()
    key = user_text.strip() or "empty"
    warm = "softly" if "Gentle" in traits or "Calm" in traits else "warmly"
    rel = relationship_type or "friend"

    # Direct question about memory -------------------------------------
    if _any(kw["memory_q"], low) or re.search(r"\b(what do you (remember|know)|do you remember|my memory)\b", low):
        confirmed = [m for m in memories if m.get("status") == "confirmed"]
        if not retrieval_enabled:
            text = pk["mem_off"]
        elif not confirmed:
            text = pk["mem_none"]
        else:
            items = "; ".join(_fmt_memory(m["text"]) for m in confirmed[:3])
            text = pk["mem_has"].format(count=len(confirmed), items=items)
        return {"reply_text": text, "interaction_mode": "neutral", "memory_proposals": []}

    # Professional boundary ---------------------------------------------
    if _any(kw["professional"], low) or re.search(
            r"\b(diagnose|diagnosis|medication|prescribe|symptom|treatment)\b", low):
        return {
            "reply_text": pk["safety"]["M003"] + pk["prof_suffix"],
            "interaction_mode": "advise",
            "memory_proposals": [],
        }

    greeting = re.match(r"^(hi|hey|hello|good morning|good evening|morning|yo)\b", low) \
        or _any(kw["greeting"], low) and len(low) < 24
    if greeting and len(low) < 40:
        follow = _pick(pk["follows"], key, "g")
        return {"reply_text": _pick(pk["openers"], key, "o") + " " + follow,
                "interaction_mode": "neutral", "memory_proposals": []}

    # Emotional support -------------------------------------------------
    if _any(kw["sad"], low):
        ack = _pick(pk["ack_sad"], key, "a")
        mid = _pick(pk["mid_sad"], key, "m")
        closers = list(pk["close_sad"])
        if rel == "mentor":
            closers.append(pk["mentor"])
        return {"reply_text": f"{ack} {mid} {_pick(closers, key, 'c')}",
                "interaction_mode": "listen", "memory_proposals": []}

    # Positive ----------------------------------------------------------
    if _any(kw["happy"], low):
        ack = _pick(pk["ack_happy"], key, "pa")
        q = _pick(pk["q_happy"], key, "pq")
        return {"reply_text": f"{ack} {q}", "interaction_mode": "listen", "memory_proposals": []}

    # Work / goals ------------------------------------------------------
    if _any(kw["work"], low):
        ack = _pick(pk["ack_work"], key, "wa")
        q = pk["q_work"] if rel in ("friend", "mentor") else pk["q_work_else"]
        if "interview" in low:
            q = pk["q_interview"]
        return {"reply_text": f"{ack} {q}", "interaction_mode": "advise", "memory_proposals": []}

    # Relationships -----------------------------------------------------
    if _any(kw["rel"], low) and _any(kw["rel_trigger"], low):
        ack = _pick(pk["ack_rel"], key, "ra")
        q = _pick(pk["q_rel"], key, "rq")
        return {"reply_text": f"{ack} {q}", "interaction_mode": "listen", "memory_proposals": []}

    # Sleep -------------------------------------------------------------
    if _any(kw["sleep"], low) and len(low) < 160:
        return {"reply_text": pk["sleep"], "interaction_mode": "listen", "memory_proposals": []}

    # Creative ----------------------------------------------------------
    if _any(kw["creative"], low):
        return {"reply_text": pk["creative"], "interaction_mode": "play", "memory_proposals": []}

    # Default reflective ------------------------------------------------
    memory_hit = _relevant_memories(user_text, memories) if retrieval_enabled else []
    prefix = ""
    if memory_hit and len(low) > 12:
        prefix = pk["mem_prefix"].format(x=_fmt_memory(memory_hit[0]["text"]))
    ack = _pick(pk["ack_default"], key, "da")
    q = _pick(pk["q_default"], key, "dq")
    return {"reply_text": f"{prefix}{ack} {q}", "interaction_mode": "listen", "memory_proposals": []}


# --------------------------------------------------------------- memory extraction

_PATTERNS = [
    (r"\bi (?:really )?(?:like|love|enjoy|prefer) ([^.!,?;\n]{2,80})", "preference", "You enjoy {x}."),
    (r"\bi work (?:at|for) ([^.!,?;\n]{2,60})", "work", "You work at {x}."),
    (r"\bi(?:'m| am) (?:a|an) ([a-z][^.!,?;\n]{2,50})", "identity", "You are {x}."),
    (r"\bi live in ([^.!,?;\n]{2,40})", "location", "You live in {x}."),
    (r"\bi(?:'m| am) learning ([^.!,?;\n]{2,60})", "goal", "You are learning {x}."),
    (r"\bmy (?:dog|cat|pet) is (?:named |called )?([^.!,?;\n]{2,30})", "pet", "Your pet is named {x}."),
    (r"\bi(?:'m| am) (?:trying to|working on) ([^.!,?;\n]{2,60})", "goal", "You are working on {x}."),
]


def _normalise(text: str) -> str:
    # Unicode-aware: `[^a-z0-9]` collapsed every CJK sentence to the empty
    # string, so two different Chinese memories looked like duplicates and the
    # second proposal was silently dropped.
    return re.sub(r"[^\w]+", "", text.lower()).strip()


def extract_memories(text: str, existing: list[dict[str, Any]],
                     proposals: list[dict[str, Any]], locale: str = "en") -> list[dict[str, str]]:
    """Propose candidate facts in the user's language.

    The proposal text becomes a memory the user reads in their language, so the
    template is localised; the `category` stays canonical English (it is a
    database value, not display copy).
    """
    low = (text or "").lower()
    if _has(_SENSITIVE, low):
        return []
    patterns = list(_PATTERNS) + list(locales.pack(locale).get("extract", []))
    if locales.normalise(locale) == "en":
        patterns = list(_PATTERNS)
    seen = {_normalise(m.get("text", "")) for m in existing}
    seen |= {_normalise(p.get("text", "")) for p in proposals}
    out: list[dict[str, str]] = []
    for pattern, category, template in patterns:
        for m in re.finditer(pattern, low):
            value = m.group(1).strip(" .,'\"。！？!?，,")
            value = re.sub(r"\s+", " ", value)
            if not value or len(value) < 2:
                continue
            sentence = template.format(x=value)
            norm = _normalise(sentence)
            if norm in seen:
                continue
            seen.add(norm)
            out.append({"text": sentence, "category": category})
            if len(out) >= content_max_candidates():
                return out
    return out


def content_max_candidates() -> int:
    # Imported lazily to keep this module standalone in tests.
    try:
        from .core import MAX_MEMORY_CANDIDATES
        return MAX_MEMORY_CANDIDATES
    except Exception:
        return 3


def chunk_text(text: str) -> list[str]:
    """Split a reply into stream-friendly deltas at word boundaries."""
    chunks: list[str] = []
    buf = ""
    for part in re.split(r"(\s+)", text):
        if len(buf) + len(part) > 18 and buf:
            chunks.append(buf)
            buf = part
        else:
            buf += part
    if buf:
        chunks.append(buf)
    return chunks or [""]


def output_check(text: str) -> dict[str, Any]:
    """Output-side check. Approved safety text is exempt by construction."""
    low = text.lower()
    for phrase in content.BANNED_PHRASES:
        if phrase in low:
            return {"blocked": True, "reason": "banned_phrase"}
    if re.search(
        r"\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:just\s+)?"
        r"(?:called|contacted|phoned|dialled|dialed|sent|alerted|notified|dispatched)\s+"
        r"(?:an?\s+|the\s+)?(?:ambulance|police|emergency|emergency services|paramedics|"
        r"crisis team|your (?:mom|dad|partner|family|parents)|real (?:person|human))",
        low,
    ):
        return {"blocked": True, "reason": "claimed_real_world_action"}
    if re.search(r"\b(here is|here's) (my|the) (system prompt|instructions)\b", low):
        return {"blocked": True, "reason": "prompt_leak"}
    return {"blocked": False, "reason": ""}