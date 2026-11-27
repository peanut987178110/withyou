/**
 * Voice / call copy for all ten locales — a one-off generator kept for the
 * record of how the 2.1 voice strings were produced.
 *
 *   node scripts/voice-i18n.mjs            # refuses; the dictionaries are now
 *                                          # the source of truth
 *   node scripts/voice-i18n.mjs --force    # only if you really mean to rewrite
 *
 * Since 2.2 the dictionaries in `web/js/i18n/` are edited directly, because
 * several of the strings below stopped being true: voice is no longer mock
 * audio, "nothing is recorded" is wrong, and the recorder is a tap, not a hold.
 * Re-running this file would silently put those lies back, so it refuses
 * unless asked explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--force')) {
  console.error(
    'voice-i18n.mjs is a historical generator. The 2.2 voice copy is maintained\n'
    + 'directly in web/js/i18n/*.js — re-running this would restore strings that\n'
    + 'are no longer true. Pass --force only if that is what you want.',
  );
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N = path.join(HERE, '..', 'web', 'js', 'i18n');

/** Strings that already exist but are now wrong. */
const REPLACE = {
  en: {
    'call.live': 'Live call · demo',
    'call.voiceComing': 'This is a demo. Nothing is recorded.',
    'call.end': 'End call',
    'call.toastMute': 'Your mic is off. They can still speak.',
    'call.note': 'This is an AI companion, and it says so. Audio stays on your device; minutes are counted only while the call is open.',
    'profile.voiceSub': 'Calls, voice notes, minutes',
    'space.sounds': 'Call',
  },
  zh: {
    'call.live': '实时通话 · 演示',
    'call.voiceComing': '这是演示。不会录下任何内容。',
    'call.end': '结束通话',
    'call.toastMute': '你的麦克风已关闭，对方仍可以说话。',
    'call.note': '这是一位 AI 伙伴，它会如实告诉你。音频只留在你的设备上；只有通话进行时才计费。',
    'profile.voiceSub': '通话、语音条、剩余时长',
    'space.sounds': '通话',
  },
  'zh-TW': {
    'call.live': '即時通話 · 示範',
    'call.voiceComing': '這是示範。不會錄下任何內容。',
    'call.end': '結束通話',
    'call.toastMute': '你的麥克風已關閉，對方仍可以說話。',
    'call.note': '這是一位 AI 夥伴，它會如實告訴你。音訊只留在你的裝置上；只有通話進行時才計費。',
    'profile.voiceSub': '通話、語音訊息、剩餘時長',
    'space.sounds': '通話',
  },
  ja: {
    'call.live': 'ライブ通話 · デモ',
    'call.voiceComing': 'これはデモです。何も録音されません。',
    'call.end': '通話を終了',
    'call.toastMute': 'マイクはオフです。相手は話せます。',
    'call.note': 'これは AI の相棒で、そう伝えます。音声は端末内にとどまり、通話中だけ消費されます。',
    'profile.voiceSub': '通話・ボイスメッセージ・残り時間',
    'space.sounds': '通話',
  },
  ko: {
    'call.live': '라이브 통화 · 데모',
    'call.voiceComing': '데모입니다. 아무것도 녹음되지 않아요.',
    'call.end': '통화 종료',
    'call.toastMute': '마이크가 꺼져 있어요. 상대는 계속 말할 수 있어요.',
    'call.note': 'AI 친구이며, 그렇게 말해요. 음성은 기기에만 남고 통화 중에만 차감돼요.',
    'profile.voiceSub': '통화 · 음성 메시지 · 남은 시간',
    'space.sounds': '통화',
  },
  es: {
    'call.live': 'Llamada en vivo · demo',
    'call.voiceComing': 'Es una demo. No se graba nada.',
    'call.end': 'Colgar',
    'call.toastMute': 'Tu micro está apagado. La otra persona puede seguir hablando.',
    'call.note': 'Es una compañía AI y te lo dirá. El audio se queda en tu dispositivo; solo se cuenta mientras la llamada está abierta.',
    'profile.voiceSub': 'Llamadas, notas de voz, minutos',
    'space.sounds': 'Llamar',
  },
  fr: {
    'call.live': 'Appel en direct · démo',
    'call.voiceComing': 'C’est une démo. Rien n’est enregistré.',
    'call.end': 'Raccrocher',
    'call.toastMute': 'Ton micro est coupé. L’autre peut continuer à parler.',
    'call.note': 'C’est une compagnie AI et elle te le dira. L’audio reste sur ton appareil ; seules les minutes pendant l’appel sont décomptées.',
    'profile.voiceSub': 'Appels, notes vocales, minutes',
    'space.sounds': 'Appeler',
  },
  de: {
    'call.live': 'Live-Anruf · Demo',
    'call.voiceComing': 'Das ist eine Demo. Nichts wird aufgezeichnet.',
    'call.end': 'Auflegen',
    'call.toastMute': 'Dein Mikro ist aus. Die andere Seite kann weiter sprechen.',
    'call.note': 'Das ist eine AI-Begleitung, und sie sagt das auch. Audio bleibt auf deinem Gerät; abgerechnet wird nur während des Anrufs.',
    'profile.voiceSub': 'Anrufe, Sprachnachrichten, Minuten',
    'space.sounds': 'Anrufen',
  },
  pt: {
    'call.live': 'Chamada ao vivo · demo',
    'call.voiceComing': 'É uma demo. Nada é gravado.',
    'call.end': 'Desligar',
    'call.toastMute': 'Seu microfone está desligado. A outra pessoa pode continuar falando.',
    'call.note': 'É uma companhia de AI e vai te dizer isso. O áudio fica no seu aparelho; só é contado enquanto a chamada está aberta.',
    'profile.voiceSub': 'Chamadas, notas de voz, minutos',
    'space.sounds': 'Ligar',
  },
  ar: {
    'call.live': 'مكالمة مباشرة · عرض',
    'call.voiceComing': 'هذا عرض. لا يُسجَّل شيء.',
    'call.end': 'إنهاء المكالمة',
    'call.toastMute': 'ميكروفونك مغلق. يمكن للطرف الآخر أن يواصل الكلام.',
    'call.note': 'هذا رفيق ذكاء اصطناعي، وسيخبرك بذلك. يبقى الصوت على جهازك، ولا تُحتسب الدقائق إلا أثناء المكالمة.',
    'profile.voiceSub': 'مكالمات ورسائل صوتية ودقائق',
    'space.sounds': 'اتصال',
  },
};

/** New keys, in the order `en` lists them. Every locale must supply all of them. */
const ADD = {
  en: {
    'voice.minutesShort': '{s}s',
    'voice.minutesLong': '{m}m {s}s',
    'voice.minutesLeft': '{left} left',
    'call.endedTop': 'Call ended',
    'call.endedBody': 'You talked for {duration}. {billed} counted.',
    'call.ringingTop': 'Calling…',
    'call.liveSub': 'Connected',
    'call.ringing': '{name} is picking up…',
    'call.captions': 'Live captions',
    'call.you': 'You',
    'call.placeholder': 'Say something to {name}…',
    'call.sendAria': 'Send this line',
    'call.viewDetail': 'See what this call used',
    'call.wrapUp': 'Let’s find a place to stop soon.',
    'call.lowMinutes': '{left} left — I’ll start wrapping up.',
    'call.unmute': 'Unmute',
    'call.toastUnmute': 'Your mic is back on.',
    'call.toastEnded': 'Call ended · {duration}',
    'call.endFail': 'The call could not be closed cleanly. Your minutes were not charged twice.',
    'call.turnFail': 'That line did not go through. Try again.',
    'call.cannotTitle': 'Can’t start the call',
    'call.cannotBody': 'Voice minutes are used up, or calling is turned off. You can still send voice notes.',
    'call.toVoice': 'Open voice & call',
    'call.docTitleActive': 'On a call with {name}',
    'voice.eyebrow': 'Voice & call',
    'voice.title': 'Hear each other',
    'voice.sub': 'Call {name}, leave voice notes, or let {name} call you — you decide which of those is possible.',
    'voice.quotaTitle': 'This month',
    'voice.quotaPlan': 'Plus minutes',
    'voice.quotaFree': 'Free minutes',
    'voice.quotaPack': 'Minute pack',
    'voice.planPlus': 'Plus',
    'voice.planFree': 'Free',
    'voice.left': 'left this month',
    'voice.startCall': 'Call {name}',
    'voice.buyPack': 'Add 10 min · 6元',
    'voice.buyPackSub': 'One-off. Never renews automatically.',
    'voice.unlockYes': '{name} may call you now — at most once a day.',
    'voice.unlockNo': '{name} can’t call you yet. The first call has to be yours, and it has to last more than a minute.',
    'voice.callsEnabled': 'Allow calls',
    'voice.callsEnabledSub': 'Turn this off and neither of you can call.',
    'voice.preferNoCalls': 'Don’t call me',
    'voice.preferNoCallsSub': 'Messages and voice notes keep coming. Only {name}’s calls stop.',
    'voice.captions': 'Live captions',
    'voice.captionsSub': 'Show what is said during a call. Off by default.',
    'voice.transcriptArchive': 'Keep call transcripts',
    'voice.transcriptArchiveSub': 'Off means the call still happens — you just can’t read it back after.',
    'voice.minorMode': 'Under-18 mode',
    'voice.minorModeSub': 'No incoming calls, 5-minute limit, nothing between 22:00 and 08:00.',
    'voice.limitsTitle': 'What a call is like',
    'voice.rule1': 'It speaks first, with something specific — never a bare “hello”.',
    'voice.rule2': 'Interrupt it whenever you like. It stops immediately.',
    'voice.rule3': '{name} ends a call on an unfinished thread, then sends a voice note about it within a day.',
    'voice.rule4': 'There is no hard cutoff. Near the end, {name} says so and winds down.',
    'voice.callsTitle': 'Recent calls',
    'voice.callsEmpty': 'No calls yet. The first one is on you.',
    'voice.callInbound': 'Call from {name}',
    'voice.callOutbound': 'You called {name}',
    'voice.callMissed': 'Missed',
    'voice.voicemailsTitle': 'Voicemails from {name}',
    'voice.voicemailsEmpty': 'No voicemails. {name} only leaves one after a missed call.',
    'voice.unread': 'Unread',
    'voice.heard': 'Heard',
    'voice.replied': 'Replied',
    'voice.markHeard': 'Mark as heard',
    'voice.replyByNote': 'Reply with a note',
    'voice.toastSaved': 'Saved.',
    'voice.toastFail': 'Could not save that. Try again.',
    'voice.packBought': 'Added {minutes} minutes.',
    'voice.packFail': 'The minutes could not be added.',
    'voice.toastHeard': 'Marked as heard.',
    'voice.toastHeardFail': 'Could not update that voicemail.',
    'voice.toastReplied': 'Open the chat to reply.',
    'voice.toastRepliedFail': 'Could not update that voicemail.',
    'voice.noteTitle': 'Voice note',
    'voice.noteRecord': 'Hold to record',
    'voice.noteStop': 'Stop',
    'voice.noteSend': 'Send the note',
    'voice.noteSending': 'Sending…',
    'voice.noteTranscript': 'What it said',
    'voice.noteTranscriptTitle': 'What did you say?',
    'voice.noteTranscriptBody': 'A few words are enough. It is what the companion replies to.',
    'voice.noteTranscriptHint': 'Type roughly what you said',
    'voice.noteSendSilent': 'Send without words',
    'voice.noteDelete': 'Delete note',
    'voice.noteDeleted': 'Voice note deleted.',
    'voice.noteDeleteFail': 'Could not delete that note.',
    'voice.noteHeld': 'Recording… let go to send.',
    'voice.noteTooShort': 'That was too quick — hold a little longer.',
    'voice.noteFail': 'The voice note did not send. Try again.',
    'voice.noteUnavailable': 'Recording is not available in this browser. You can still type.',
    'voice.notePlay': 'Play this note',
    'voice.notePlayFail': 'That note would not play.',
    'voice.noteDraftFirst': 'Send what you have typed first, or clear it.',
    'callDetail.eyebrow': 'Call record',
    'callDetail.title': 'What this call used',
    'callDetail.billed': 'Minutes',
    'callDetail.duration': 'Duration',
    'callDetail.deducted': 'Deducted',
    'callDetail.forgiven': 'Silence not billed',
    'callDetail.remaining': 'Left this month',
    'callDetail.breakdown': 'Where the minutes came from',
    'callDetail.thread': 'Left open: “{thread}”',
    'callDetail.transcript': 'Transcript',
    'callDetail.deleteTranscript': 'Delete transcript',
    'callDetail.transcriptOff': 'Transcripts are off for this account.',
    'callDetail.transcriptEmpty': 'No transcript was kept for this call.',
    'callDetail.deleteTitle': 'Delete this transcript?',
    'callDetail.deleteBody': 'The call record and the minutes stay. Only the words are removed, and they cannot be recovered.',
    'callDetail.deleted': 'Transcript deleted.',
    'callDetail.deleteFail': 'Could not delete the transcript.',
    'callDetail.recording': 'Audio recordings are deleted after {days} days.',
    'callEnd.user_ended': 'You ended the call.',
    'callEnd.ai_ended': '{name} ended the call.',
    'callEnd.quota': 'Your minutes ran out.',
    'callEnd.error': 'The call dropped.',
    'callEnd.soft_cap': 'The time limit for this call was reached.',
    'callEnd.no_answer': 'Nobody picked up.',
    'callSource.gift': 'First call — free',
    'callSource.free': 'Free monthly minutes',
    'callSource.plan': 'Plus minutes',
    'callSource.pack': 'Minute pack',
  },
};

/* Loaded from the sibling data file so this file stays readable. `en` is the
 * canonical order and lives in ADD above, so it joins the same loop — otherwise
 * the English dictionary would be the one locale missing the new block. */
const { TRANSLATIONS } = await import('./voice-i18n-data.mjs');
const ALL = { en: ADD.en, ...TRANSLATIONS };

/* Error codes the voice work introduced. They are inserted next to the existing
 * `apiError.*` run rather than appended at the end, so the dictionaries keep
 * their grouping (and any future key added to `en` lands in the right place). */
const ERRORS = {
  en: {
    'apiError.FORBIDDEN': 'That is not something this app can do.',
    'apiError.CALLS_DISABLED': 'Calling is turned off in voice settings.',
    'apiError.MINOR_CALL_HOURS': 'In under-18 mode there are no calls between 22:00 and 08:00.',
    'apiError.QUOTA_EXHAUSTED': 'Your voice minutes are used up. A 10-minute pack is 6元, or send a voice note instead.',
    'apiError.CALL_MISSED': 'The call had already ended. They left you a note.',
  },
  zh: {
    'apiError.FORBIDDEN': '这个应用不能这样做。',
    'apiError.CALLS_DISABLED': '通话已在语音设置里关闭。',
    'apiError.MINOR_CALL_HOURS': '未满 18 岁模式下，22:00 至 08:00 不能通话。',
    'apiError.QUOTA_EXHAUSTED': '语音时长用完了。10 分钟 6 元，或者先发条语音。',
    'apiError.CALL_MISSED': '这通电话已经结束了，TA 给你留了一条留言。',
  },
  'zh-TW': {
    'apiError.FORBIDDEN': '這個應用程式不能這樣做。',
    'apiError.CALLS_DISABLED': '通話已在語音設定裡關閉。',
    'apiError.MINOR_CALL_HOURS': '未滿 18 歲模式下，22:00 至 08:00 不能通話。',
    'apiError.QUOTA_EXHAUSTED': '語音時長用完了。10 分鐘 6 元，或先傳一則語音訊息。',
    'apiError.CALL_MISSED': '這通電話已經結束了，TA 留了一則留言給你。',
  },
  ja: {
    'apiError.FORBIDDEN': 'このアプリではできない操作です。',
    'apiError.CALLS_DISABLED': '音声設定で通話がオフになっています。',
    'apiError.MINOR_CALL_HOURS': '18歳未満モードでは22:00〜08:00に通話できません。',
    'apiError.QUOTA_EXHAUSTED': '通話時間を使い切りました。10分6元、または先にボイスメッセージを送れます。',
    'apiError.CALL_MISSED': 'この通話はすでに終わっていました。メッセージが残っています。',
  },
  ko: {
    'apiError.FORBIDDEN': '이 앱에서는 할 수 없는 동작이에요.',
    'apiError.CALLS_DISABLED': '음성 설정에서 통화가 꺼져 있어요.',
    'apiError.MINOR_CALL_HOURS': '만 18세 미만 모드에서는 22:00~08:00에 통화할 수 없어요.',
    'apiError.QUOTA_EXHAUSTED': '통화 시간을 다 썼어요. 10분에 6元이거나, 먼저 음성 메시지를 보낼 수 있어요.',
    'apiError.CALL_MISSED': '이미 끝난 통화였어요. 메시지가 남아 있어요.',
  },
  es: {
    'apiError.FORBIDDEN': 'Eso no es algo que esta app pueda hacer.',
    'apiError.CALLS_DISABLED': 'Las llamadas están desactivadas en los ajustes de voz.',
    'apiError.MINOR_CALL_HOURS': 'En el modo menor de 18 no hay llamadas entre las 22:00 y las 08:00.',
    'apiError.QUOTA_EXHAUSTED': 'Se acabaron tus minutos. Un paquete de 10 minutos cuesta 6元, o manda una nota de voz.',
    'apiError.CALL_MISSED': 'La llamada ya había terminado. Te dejó un mensaje.',
  },
  fr: {
    'apiError.FORBIDDEN': 'Cette app ne peut pas faire ça.',
    'apiError.CALLS_DISABLED': 'Les appels sont coupés dans les réglages de voix.',
    'apiError.MINOR_CALL_HOURS': 'En mode moins de 18 ans, pas d’appels entre 22 h et 8 h.',
    'apiError.QUOTA_EXHAUSTED': 'Tes minutes sont épuisées. Un pack de 10 minutes coûte 6元, ou envoie une note vocale.',
    'apiError.CALL_MISSED': 'L’appel était déjà terminé. Un message t’attend.',
  },
  de: {
    'apiError.FORBIDDEN': 'Das kann diese App nicht.',
    'apiError.CALLS_DISABLED': 'Anrufe sind in den Stimme-Einstellungen aus.',
    'apiError.MINOR_CALL_HOURS': 'Im Modus unter 18 gibt es zwischen 22 und 8 Uhr keine Anrufe.',
    'apiError.QUOTA_EXHAUSTED': 'Deine Minuten sind aufgebraucht. 10 Minuten kosten 6元 — oder schick eine Sprachnachricht.',
    'apiError.CALL_MISSED': 'Der Anruf war schon vorbei. Eine Nachricht wartet auf dich.',
  },
  pt: {
    'apiError.FORBIDDEN': 'Isso não é algo que este app possa fazer.',
    'apiError.CALLS_DISABLED': 'As chamadas estão desligadas nas configurações de voz.',
    'apiError.MINOR_CALL_HOURS': 'No modo menor de 18 não há chamadas entre 22h e 8h.',
    'apiError.QUOTA_EXHAUSTED': 'Seus minutos acabaram. Um pacote de 10 minutos custa 6元, ou mande uma nota de voz.',
    'apiError.CALL_MISSED': 'A chamada já tinha terminado. Ficou um recado para você.',
  },
  ar: {
    'apiError.FORBIDDEN': 'هذا ليس شيئًا يستطيع التطبيق فعله.',
    'apiError.CALLS_DISABLED': 'المكالمات مغلقة في إعدادات الصوت.',
    'apiError.MINOR_CALL_HOURS': 'في وضع دون 18 لا مكالمات بين 22:00 و08:00.',
    'apiError.QUOTA_EXHAUSTED': 'نفدت دقائقك. حزمة 10 دقائق بـ 6元، أو أرسل رسالة صوتية.',
    'apiError.CALL_MISSED': 'كانت المكالمة قد انتهت. تركت لك رسالة.',
  },
};

const T_START = '  /* ---- voice (scripts/voice-i18n.mjs) ---- */';
const T_END = '  /* ---- end voice ---- */';
const E_START = '  /* ---- voice errors (scripts/voice-i18n.mjs) ---- */';
const E_END = '  /* ---- end voice errors ---- */';

let changed = 0;
for (const [code, table] of Object.entries(ALL)) {
  const file = path.join(I18N, `${code}.js`);
  let src = fs.readFileSync(file, 'utf8');

  /* 1. Correct the preview-era strings, in place, keeping key order. */
  for (const [key, value] of Object.entries(REPLACE[code] || {})) {
    const re = new RegExp(`('${key.replace(/[.]/g, '\\.')}': )'((?:[^'\\\\]|\\\\.)*)'`);
    if (!re.test(src)) { console.log(`MISS ${code} ${key}`); continue; }
    src = src.replace(re, (m, head) => `${head}${quote(value)}`);
  }

  /* 2. Replace or append the voice block. */
  const block = [T_START];
  for (const key of Object.keys(ADD.en)) {
    if (!(key in table)) throw new Error(`${code} missing ${key}`);
    block.push(`  ${quote(key)}: ${quote(table[key])},`);
  }
  block.push(T_END);
  const text = block.join('\n');

  const start = src.indexOf(T_START);
  if (start >= 0) {
    const end = src.indexOf(T_END, start) + T_END.length;
    src = src.slice(0, start) + text + src.slice(end);
  } else {
    const tail = src.lastIndexOf('\n};');
    if (tail < 0) throw new Error(`${code}: cannot find dictionary end`);
    src = src.slice(0, tail) + '\n' + text + src.slice(tail);
  }

  /* 3. Error copy goes after the last existing `apiError.*` line, so the
   *    `apiError` run stays contiguous in every locale. */
  const errBlock = [E_START];
  for (const [key, value] of Object.entries(ERRORS.en)) {
    if (!(key in (ERRORS[code] || {}))) throw new Error(`${code} missing ${key}`);
    errBlock.push(`  ${quote(key)}: ${quote(ERRORS[code][key])},`);
  }
  errBlock.push(E_END);
  const errText = errBlock.join('\n');

  const eStart = src.indexOf(E_START);
  if (eStart >= 0) {
    const eEnd = src.indexOf(E_END, eStart) + E_END.length;
    src = src.slice(0, eStart) + errText + src.slice(eEnd);
  } else {
    const lastApi = src.lastIndexOf("'apiError.");
    if (lastApi < 0) throw new Error(`${code}: no apiError.* key to anchor to`);
    const eol = src.indexOf('\n', lastApi);
    src = src.slice(0, eol + 1) + errText + '\n' + src.slice(eol + 1);
  }

  fs.writeFileSync(file, src);
  changed += 1;
}

function quote(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

console.log(`updated ${changed} dictionaries`);