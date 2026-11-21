/* P01 welcome, sign in / sign up, P02 age + region, P03 create companion. */

import { api, setToken, ApiFailure } from '../api.js';
import { html, raw, icon, toast } from '../dom.js';
import { state, route, go, loadSession, loadMeta, renderApp } from '../state.js';
import { topbar } from '../ui.js';
import { t, locale, LANGUAGES } from '../i18n.js';
import { openLanguageSheet } from '../language.js';

const sky = () => html`<div class="sky" aria-hidden="true">
  <div class="stars">
    <i style="left:12%;top:14%;width:3px;height:3px"></i>
    <i style="left:24%;top:32%;width:2px;height:2px;animation-delay:.6s"></i>
    <i style="left:8%;top:52%;width:2.5px;height:2.5px;animation-delay:1.2s"></i>
    <i style="left:38%;top:8%;width:2px;height:2px;animation-delay:1.8s"></i>
    <i style="left:54%;top:24%;width:2px;height:2px;animation-delay:.3s"></i>
    <i style="left:68%;top:6%;width:3px;height:3px;animation-delay:2.2s"></i>
    <i style="left:86%;top:34%;width:2px;height:2px;animation-delay:1.4s"></i>
  </div>
  <div class="moon"></div>
  <div class="horizon"></div>
  <div class="horizon two"></div>
</div>`;

route('welcome', () => html`
  <section class="screen welcome">
    <div class="brand"><span class="spark">✦</span> withyou</div>
    ${sky()}
    <div class="welcome-copy">
      <div class="eyebrow">${t('welcome.eyebrow')}</div>
      <h1>${t('welcome.title1')}<br>${t('welcome.title2')}</h1>
      <p>${t('welcome.body')}</p>
      <div class="welcome-actions">
        <button class="btn lg" type="button" data-go="signup">${t('welcome.create')}</button>
        <button class="btn lg secondary" type="button" data-go="signin">${t('welcome.signin')}</button>
      </div>
      <p class="welcome-note">${t('welcome.note')}</p>
      <button class="lang-chip" type="button" data-lang-open>
        ${icon('compass')}<span data-lang-name>${currentLanguageName()}</span>
      </button>
    </div>
  </section>`, {
  onMount: (root) => {
    const btn = root.querySelector('[data-lang-open]');
    if (btn) btn.addEventListener('click', () => openLanguageSheet());
  },
});

function currentLanguageName() {
  const hit = LANGUAGES.find((l) => l.code === locale());
  return hit ? hit.name : 'English';
}

function authLayout(title, sub, formHtml, footHtml) {
  return html`<div class="screen">
    <div class="scroll no-nav">
      <div class="auth-page">
        ${topbar({ back: 'welcome', title: '' })}
        <div class="auth-head">
          <div class="eyebrow">withyou</div>
          <h1>${title}</h1>
          <p class="sub">${sub}</p>
        </div>
        ${raw(formHtml)}
        <div class="auth-foot">${raw(footHtml)}</div>
      </div>
    </div>
  </div>`;
}

function authForm(mode) {
  const signup = mode === 'signup';
  return `
    <form class="auth-form" id="auth-form" novalidate>
      ${signup ? `<label class="field-label" for="name">${t('auth.name')}</label>
        <input class="field" id="name" name="name" autocomplete="given-name" placeholder="${t('auth.placeholderName')}" maxlength="40">` : ''}
      <label class="field-label" for="email">${t('auth.email')}</label>
      <input class="field" id="email" name="email" type="email" autocomplete="email"
        inputmode="email" placeholder="you@example.com" required>
      <label class="field-label" for="password">${t('auth.password')}</label>
      <input class="field" id="password" name="password" type="password"
        autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="${t('auth.placeholderPassword')}" required>
      <div class="field-error" id="auth-error" role="alert" hidden></div>
      <button class="btn accent block lg" type="submit" id="auth-submit">${signup ? t('auth.createAccount') : t('auth.signin')}</button>
    </form>
    <div class="stack tight mt-24">
      <p class="hint center">${t('auth.demoHint')}</p>
      <div class="chips" style="justify-content:center">
        <button class="chip" type="button" data-demo="alex@withyou.demo">${t('auth.demoAlex')}</button>
        <button class="chip" type="button" data-demo="sam@withyou.demo">${t('auth.demoSam')}</button>
        <button class="chip" type="button" data-demo="new@withyou.demo">${t('auth.demoRiley')}</button>
      </div>
    </div>`;
}

async function afterAuth() {
  await loadSession();
  if (!state.me) return go('welcome');
  if (!state.me.age_verified) return go('age');
  if (!state.companion) return go('create');
  go('home');
}

function wireAuthForm(root, mode) {
  const form = root.querySelector('#auth-form');
  const error = root.querySelector('#auth-error');
  const btn = root.querySelector('#auth-submit');

  const showError = (msg) => {
    error.textContent = msg;
    error.hidden = false;
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showError(t('auth.errEmail'));
    if (password.length < 6) return showError(t('auth.errPassword'));
    btn.disabled = true;
    btn.textContent = mode === 'signup' ? t('auth.creating') : t('auth.signingIn');
    try {
      const path = mode === 'signup' ? '/auth/register' : '/auth/login';
      const body = mode === 'signup'
        ? { email, password, display_name: form.name ? form.name.value.trim() : '', locale: locale() }
        : { email, password };
      const data = await api.post(path, body);
      setToken(data.token);
      await afterAuth();
    } catch (err) {
      // Server errors arrive with a stable `code`; `display` is that code
      // rendered in the active language (see api.js / i18n.apiErrorText).
      const msg = err instanceof ApiFailure ? (err.display || err.message) : t('auth.errGeneric');
      showError(msg);
      btn.disabled = false;
      btn.textContent = mode === 'signup' ? t('auth.createAccount') : t('auth.signin');
    }
  });

  root.querySelectorAll('[data-demo]').forEach((b) => {
    b.addEventListener('click', async () => {
      form.email.value = b.getAttribute('data-demo');
      form.password.value = 'demo1234';
      form.requestSubmit();
    });
  });
}

route('signup', () => authLayout(
  t('auth.signupTitle'),
  t('auth.signupSub'),
  authForm('signup'),
  `${t('auth.signupFoot')} <button class="text-link" data-go="signin">${t('auth.signin')}</button>`,
), {
  onMount: (root) => wireAuthForm(root, 'signup'),
  focus: '#name',
});

route('signin', () => authLayout(
  t('auth.signinTitle'),
  t('auth.signinSub'),
  authForm('signin'),
  `${t('auth.signinFoot')} <button class="text-link" data-go="signup">${t('auth.createAnAccount')}</button>`,
), {
  onMount: (root) => wireAuthForm(root, 'signin'),
  focus: '#email',
});

/* ------------------------------------------------------- P02 age + region */

const REGION_CODES = ['US', 'GB', 'CA', 'AU', 'CN', 'SG', 'DE', 'FR', 'IN', 'JP', 'OTHER'];

route('age', () => html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'welcome', eyebrow: t('age.eyebrow'), title: t('age.title') })}
      <div class="mt-24">
        <h2 class="display h2">${t('age.heading')}</h2>
        <p class="sub">${t('age.sub')}</p>
      </div>

      <div class="card mt-24">
        <div class="row between">
          <div class="grow">
            <div class="card-title">${t('age.adultTitle')}</div>
            <p class="card-desc">${t('age.adultDesc')}</p>
          </div>
          <button class="toggle" id="age-toggle" role="switch" aria-checked="false"
            aria-label="${t('age.adultTitle')}"></button>
        </div>
      </div>

      <label class="field-label mt-24" for="region">${t('age.region')}</label>
      <p class="hint mb-8">${t('age.regionHint')}</p>
      <select class="field" id="region">
        <option value="">${t('age.chooseRegion')}</option>
        ${REGION_CODES.map((code) => html`<option value="${code}">${t(`region.${code}`)}</option>`)}
      </select>

      <div class="inline-note mt-24">
        <span>${icon('shield')}</span>
        <span>${t('age.note')}</span>
      </div>

      <div class="field-error" id="age-error" role="alert" hidden></div>
      <button class="btn accent block lg mt-24" id="age-continue" disabled>${t('age.continue')}</button>
    </div>
  </div>`, {
  onMount: (root) => {
    const toggle = root.querySelector('#age-toggle');
    const region = root.querySelector('#region');
    const btn = root.querySelector('#age-continue');
    const error = root.querySelector('#age-error');
    let adult = false;

    const sync = () => { btn.disabled = !(adult && region.value); };
    toggle.addEventListener('click', () => {
      adult = !adult;
      toggle.setAttribute('aria-checked', String(adult));
      sync();
    });
    region.addEventListener('change', sync);

    btn.addEventListener('click', async () => {
      error.hidden = true;
      if (!adult) {
        error.textContent = t('age.errAdult');
        error.hidden = false;
        return;
      }
      if (!region.value) {
        error.textContent = t('age.errRegion');
        error.hidden = false;
        return;
      }
      btn.disabled = true;
      btn.textContent = t('common.saving');
      try {
        await api.post('/auth/attestation', {
          age_verified: true,
          region: region.value,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          tz_offset_minutes: -new Date().getTimezoneOffset(),
          locale: locale(),
        });
        await loadSession();
        go('create');
      } catch (err) {
        error.textContent = err.display || err.message || t('age.errGeneric');
        error.hidden = false;
        btn.disabled = false;
        btn.textContent = t('age.continue');
      }
    });
  },
});

/* ------------------------------------------------------ P03 create partner */

const INTENTS = [
  { id: 'talk', glyph: '◌', titleKey: 'create.intentTalkTitle', descKey: 'create.intentTalkDesc' },
  { id: 'motivate', glyph: '✦', titleKey: 'create.intentMotivateTitle', descKey: 'create.intentMotivateDesc' },
  { id: 'create', glyph: '♧', titleKey: 'create.intentCreateTitle', descKey: 'create.intentCreateDesc' },
];

const TRAITS = ['Warm', 'Calm', 'Playful', 'Curious', 'Grounded', 'Encouraging', 'Witty', 'Gentle'];

const ENERGY_KEYS = { calm: 'create.energyCalm', steady: 'create.energySteady', playful: 'create.energyPlayful' };

/** Trait ids stay English (they are persisted and sent to the backend). */
function traitLabel(id) { return t(`trait.${id}`); }

function energyLabelFor(v) {
  return t(v < 34 ? ENERGY_KEYS.calm : v > 66 ? ENERGY_KEYS.playful : ENERGY_KEYS.steady);
}

route('create', () => {
  if (!state.me) return html`<div class="screen">${topbar({ title: t('create.signinFirst') })}</div>`;
  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'age', eyebrow: t('create.eyebrow'), title: t('create.title') })}
      <p class="sub">${t('create.sub')}</p>

      <div class="portrait-stage" id="portrait-stage">
        <div class="portrait">
          <div class="hair"></div><div class="face"></div>
          <div class="body"></div><div class="collar"></div>
        </div>
        <span class="spark">✦</span>
      </div>

      <label class="field-label" for="comp-name">${t('create.name')}</label>
      <input class="field" id="comp-name" maxlength="24" placeholder="${t('create.placeholderName')}" value="Mia"
        autocomplete="off" spellcheck="false">
      <p class="hint mt-8">${t('create.nameHint')}</p>

      <label class="field-label mt-24">${t('create.hoping')}</label>
      <div class="intent-list" role="group" aria-label="${t('create.hoping')}">
        ${INTENTS.map((it, i) => html`
          <button class="intent" type="button" data-intent="${it.id}"
            aria-pressed="${i === 0 ? 'true' : 'false'}">
            <span class="glyph">${it.glyph}</span>
            <span class="copy"><strong>${t(it.titleKey)}</strong><em>${t(it.descKey)}</em></span>
            <span class="check">✓</span>
          </button>`)}
      </div>

      <label class="field-label mt-24">${t('create.character')} <span class="tiny" id="trait-count">0 / 5</span></label>
      <div class="chips" id="trait-list" role="group" aria-label="${t('create.character')}">
        ${TRAITS.map((tr) => html`<button class="chip" type="button" data-trait="${tr}"
          aria-pressed="false">${traitLabel(tr)}</button>`)}
      </div>

      <label class="field-label mt-24" for="energy">${t('create.energy')}</label>
      <input type="range" id="energy" min="0" max="100" value="60" style="width:100%;accent-color:#5968ef">
      <div class="row between tiny"><span>${t('create.energyCalm')}</span><span id="energy-label">${t('create.energyPlayful')}</span></div>

      <div class="card wash mt-24">
        <div class="row top">
          <span>${icon('info')}</span>
          <p class="card-desc" style="color:#4c4794">${t('create.notice')}</p>
        </div>
      </div>

      <div class="field-error" id="create-error" role="alert" hidden></div>
      <button class="btn accent block lg mt-24" id="create-continue">${t('create.cta')}</button>
    </div>
  </div>`;
}, {
  onMount: (root) => {
    const nameInput = root.querySelector('#comp-name');
    const count = root.querySelector('#trait-count');
    const list = root.querySelector('#trait-list');
    const energy = root.querySelector('#energy');
    const energyLabel = root.querySelector('#energy-label');
    const error = root.querySelector('#create-error');
    let intent = 'talk';
    const traits = new Set(['Warm']);

    const syncTraits = () => {
      count.textContent = `${traits.size} / 5`;
      list.querySelectorAll('[data-trait]').forEach((b) => {
        b.setAttribute('aria-pressed', String(traits.has(b.getAttribute('data-trait'))));
      });
    };
    syncTraits();

    root.querySelectorAll('[data-intent]').forEach((b) => {
      b.addEventListener('click', () => {
        intent = b.getAttribute('data-intent');
        root.querySelectorAll('[data-intent]').forEach((x) => {
          x.setAttribute('aria-pressed', String(x === b));
        });
      });
    });

    list.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-trait]');
      if (!b) return;
      const value = b.getAttribute('data-trait');
      if (traits.has(value)) traits.delete(value);
      else if (traits.size < 5) traits.add(value);
      else toast(t('create.errTraits'));
      syncTraits();
    });

    energy.addEventListener('input', () => {
      energyLabel.textContent = energyLabelFor(Number(energy.value));
    });

    root.querySelector('#create-continue').addEventListener('click', async (ev) => {
      error.hidden = true;
      const name = nameInput.value.trim();
      if (!name) {
        error.textContent = t('create.errName');
        error.hidden = false;
        return;
      }
      if (name.length > 24) {
        error.textContent = t('create.errNameLong');
        error.hidden = false;
        return;
      }
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = t('common.creating');
      try {
        await api.post('/companions', {
          name,
          traits: Array.from(traits),
          relationship_type: 'friend',
          intent,
          energy: Number(energy.value),
        });
        await loadSession();
        await loadMeta();
        go('chat');
      } catch (err) {
        error.textContent = err.display || err.message || t('create.errGeneric');
        error.hidden = false;
        btn.disabled = false;
        btn.textContent = t('create.cta');
      }
    });
  },
  focus: '#comp-name',
});