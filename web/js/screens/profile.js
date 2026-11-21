/* P12 Profile, P13 Memory, P14 Relationship, P15 Privacy, P16 Plus. */

import { api } from '../api.js';
import { html, raw, icon, toast, openSheet, confirmSheet, timeAgo, prettyDate, initials } from '../dom.js';
import { state, route, go, loadSession, levelLabel, mountGuard } from '../state.js';
import { topbar, loadingBlock, subscriptionLabel, walletPills, tabbar } from '../ui.js';
import { t, tf, locale, LANGUAGES } from '../i18n.js';
import { openLanguageSheet } from '../language.js';

/* ---------------------------------------------------------------- profile */

function currentLanguageName() {
  const hit = LANGUAGES.find((l) => l.code === locale());
  return hit ? hit.name : 'English';
}

route('profile', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const me = state.me;
  const comp = state.companion;
  const wallet = state.wallet || { xp: me.xp, lumen: me.lumen, level: { level: 1, name: levelLabel(1) } };
  const info = wallet.level || {};
  const since = me.created_at ? Math.max(1, Math.round((Date.now() - new Date(me.created_at.replace(' ', 'T')).getTime()) / 86400000)) : 1;
  const sub = state.subscription || null;
  const compName = comp ? comp.name : t('chat.companionFallback');
  // The voice row shows the live balance, because "how many minutes do I have
  // left" is the question people open this page to answer. Failing quietly here
  // is right: the row still works as a link.
  const voice = await api.get('/voice').catch(() => null);
  const voiceLeft = voice && voice.quota
    ? t('voice.minutesLeft', { left: voice.quota.seconds_left >= 60
        ? t('voice.minutesLong', { m: Math.floor(voice.quota.seconds_left / 60), s: voice.quota.seconds_left % 60 })
        : t('voice.minutesShort', { s: voice.quota.seconds_left }) })
    : t('profile.manage');

  return html`
  <div class="screen">
    <div class="scroll">
      ${topbar({ eyebrow: t('profile.eyebrow'), title: t('profile.title') })}

      <div class="profile-hero">
        <div class="profile-avatar">${initials(me.display_name || me.email)}</div>
        <h2>${me.display_name || t('common.you')}</h2>
        <p>${comp
          ? t('profile.withDays', { name: comp.name, days: t(since === 1 ? 'profile.days.one' : 'profile.days.other', { count: since }) })
          : t('profile.adultMode')}</p>
      </div>

      ${sub && sub.status !== 'none' && sub.status !== 'expired'
        ? html`<button class="plus-strip" type="button" data-go="plus">
            <b>withyou plus</b>
            <span>${subscriptionLabel(sub)}${sub.entitlement_end_at ? ` · ${prettyDate(sub.entitlement_end_at)}` : ''}</span>
            <span class="go">${t('profile.manage')}</span>
          </button>`
        : html`<button class="plus-strip" type="button" data-go="plus">
            <b>withyou plus</b>
            <span>${t('profile.plusTagline')}</span>
            <span class="go">${t('profile.viewBenefits')}</span>
          </button>`}

      <div class="stat-row">
        <div class="stat"><b>${wallet.xp || 0}</b><small>XP</small></div>
        <div class="stat"><b>${wallet.lumen || 0}</b><small>LUMEN</small></div>
        <div class="stat"><b>${info.level || 1}</b><small>${t('unit.level')}</small></div>
      </div>

      <div class="card mt-16">
        <div class="row between">
          <div>
            <div class="card-title">${t('profile.levelTitle', {
              level: info.level || 1,
              // The level name comes from the backend in English; `tf` renders it
              // in the active language and falls back to the server's text if a
              // new level ships before the dictionaries know about it.
              name: tf(`level.${info.level || 1}`, info.name || levelLabel(info.level || 1)),
            })}</div>
            <p class="card-desc">${info.next_at
              ? t('profile.xpToNext', { n: info.next_at - (wallet.xp || 0) })
              : t('profile.topLevel')}</p>
          </div>
          <button class="btn sm ghost" type="button" data-go="rewards">${t('profile.rewards')}</button>
        </div>
        <div class="xp-bar mt-12"><i style="width:${Math.round((info.progress || 0) * 100)}%"></i></div>
      </div>

      <div class="settings-group mt-16">
        <button class="setting" type="button" data-go="relationship">
          <span class="label">${t('profile.relationship')}<small>${t('profile.relationshipSub', { name: compName })}</small></span>
          <span class="value">${relName(comp && comp.relationship_type)}</span>
          ${icon('chev', 'chev')}
        </button>
        <button class="setting" type="button" data-go="memory">
          <span class="label">${t('profile.memoryCenter')}<small>${t('profile.memorySub', { name: compName })}</small></span>
          <span class="value">${t('profile.manage')}</span>
          ${icon('chev', 'chev')}
        </button>
        <button class="setting" type="button" data-toggle="checkins">
          <span class="label">${t('profile.checkins')}<small>${t('profile.checkinsSub')}</small></span>
          <span class="toggle" role="switch" aria-checked="${me.proactive_checkins ? 'true' : 'false'}"
            aria-label="${t('profile.checkins')}" data-switch></span>
        </button>
        <button class="setting" type="button" data-go="privacy">
          <span class="label">${t('profile.privacy')}<small>${t('profile.privacySub')}</small></span>
          <span class="value">${t('profile.manage')}</span>
          ${icon('chev', 'chev')}
        </button>
        <button class="setting" type="button" data-go="voice">
          <span class="label">${t('profile.voice')}<small>${t('profile.voiceSub')}</small></span>
          <span class="value">${voiceLeft}</span>
          ${icon('chev', 'chev')}
        </button>
        <button class="setting" type="button" id="profile-language">
          <span class="label">${t('profile.language')}<small>${t('profile.languageSub')}</small></span>
          <span class="value" id="language-value">${currentLanguageName()}</span>
          ${icon('chev', 'chev')}
        </button>
      </div>

      <div class="settings-group mt-16">
        <button class="setting" type="button" data-info="about">
          <span class="label">${t('profile.about')}<small>${t('profile.aboutSub')}</small></span>
          ${icon('chev', 'chev')}
        </button>
        <button class="setting" type="button" data-info="safety">
          <span class="label">${t('profile.safety')}<small>${t('profile.safetySub', { region: me.region ? tf(`region.${me.region}`, me.region) : t('common.notSet') })}</small></span>
          ${icon('chev', 'chev')}
        </button>
        <button class="setting danger" type="button" data-signout>
          <span class="label">${t('profile.signOut')}</span>
        </button>
      </div>

      <p class="tiny center mt-24">WithYou 2.1 · ${me.email}</p>
      <div style="height:12px"></div>
    </div>
    ${tabbar('profile')}
  </div>`;
}, {
  onMount: (root) => {
    root.querySelectorAll('[data-toggle]').forEach((b) => {
      b.addEventListener('click', async () => {
        const sw = b.querySelector('[data-switch]');
        const next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(next));
        try {
          await api.patch('/settings/notifications', { proactive_checkins: next });
          if (state.me) state.me.proactive_checkins = next;
          toast(next ? t('profile.checkinsOn') : t('profile.checkinsOff'));
        } catch (err) {
          sw.setAttribute('aria-checked', String(!next));
          toast(err.display || err.message || t('profile.couldNotSave'), 'error');
        }
      });
    });
    const langBtn = root.querySelector('#profile-language');
    if (langBtn) langBtn.addEventListener('click', () => openLanguageSheet());
    root.querySelectorAll('[data-info]').forEach((b) => {
      b.addEventListener('click', () => {
        const which = b.getAttribute('data-info');
        if (which === 'about') {
          openSheet({
            title: t('profile.about'),
            body: `<p class="sub">${t('profile.aboutBody1')}</p>
              <p class="sub">${t('profile.aboutBody2')}</p>`,
            actions: [{ label: t('common.close'), kind: 'accent' }],
          });
        } else {
          openSheet({
            title: t('profile.safety'),
            body: `<p class="sub">${t('profile.safetyBody')}</p>`,
            actions: [{ label: t('common.close'), kind: 'accent' }],
          });
        }
      });
    });
    root.querySelector('[data-signout]').addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: t('profile.signOutTitle'),
        body: `<p class="sub">${t('profile.signOutBody')}</p>`,
        confirmLabel: t('profile.signOut'),
      });
      if (!ok) return;
      try { await api.post('/auth/logout', {}); } catch (e) { /* ignore */ }
      // 用 app.js 的统一入口：它会连聊天页的待定提议一起清掉，
      // 否则下一个登录的账号会看到上一个账号留下的记忆卡片。
      const { forgetUserState } = await import('../app.js');
      forgetUserState();
      const { setToken } = await import('../api.js');
      setToken(null);
      go('welcome');
    });
  },
});

function relName(id) {
  return t(`rel.${id || 'friend'}`);
}

/* ----------------------------------------------------------------- memory */

route('memory', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const data = await api.get('/memories');
  const settings = data.settings || {};
  const name = state.companion ? state.companion.name : t('chat.companionFallback');
  const items = data.items || [];
  const proposals = data.proposals || [];

  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'profile', eyebrow: t('memory.eyebrow', { name }), title: '' })}
      <p class="sub">${t('memory.sub')}</p>

      <div class="row between mt-16">
        <div>
          <div class="eyebrow">${t('memory.switches')}</div>
          <p class="card-desc mt-8">${t('memory.switchesDesc')}</p>
        </div>
      </div>
      <div class="settings-group mt-12">
        <div class="setting">
          <span class="label">${t('memory.extraction')}<small>${t('memory.extractionSub')}</small></span>
          <button class="toggle" role="switch" data-switch="extraction_enabled"
            aria-checked="${settings.extraction_enabled ? 'true' : 'false'}"
            aria-label="${t('memory.extraction')}"></button>
        </div>
        <div class="setting">
          <span class="label">${t('memory.retrieval')}<small>${t('memory.retrievalSub')}</small></span>
          <button class="toggle" role="switch" data-switch="retrieval_enabled"
            aria-checked="${settings.retrieval_enabled ? 'true' : 'false'}"
            aria-label="${t('memory.retrieval')}"></button>
        </div>
      </div>

      ${proposals.length ? html`
        <div class="section-head"><h2>${t('memory.waiting')}</h2><span class="meta">${proposals.length}</span></div>
        <div class="stack">
          ${proposals.map((p) => html`
            <div class="memory-card pending" data-pid="${p.id}">
              <div class="top">
                <span class="badge accent">${t('memory.suggested')}</span>
                <span class="tiny">${p.category || t('chat.categoryFallback')}</span>
              </div>
              <div class="text">${p.text}</div>
              <div class="actions">
                <button class="btn sm soft" type="button" data-pact="confirm" data-pid="${p.id}">${t('memory.remember')}</button>
                <button class="btn sm ghost" type="button" data-pact="session_only" data-pid="${p.id}">${t('chat.justThisChat')}</button>
                <button class="btn sm ghost" type="button" data-pact="reject" data-pid="${p.id}">${t('memory.no')}</button>
              </div>
            </div>`)}
        </div>` : ''}

      <div class="section-head"><h2>${t('memory.confirmed')}</h2><span class="meta">${items.length}</span></div>
      ${items.length === 0 ? html`
        <div class="empty">
          <div class="glyph">✦</div>
          <h3>${t('memory.emptyTitle')}</h3>
          <p>${t('memory.emptyDesc', { name })}</p>
        </div>` : html`
        <div class="stack">
          ${items.map((m) => html`
            <div class="memory-card" data-mid="${m.id}">
              <div class="top">
                <span class="badge good">${t('memory.confirmedAgo', { ago: timeAgo(m.created_at) })}</span>
                <span class="tiny">${m.category}</span>
              </div>
              <div class="text">${m.text}</div>
              <div class="actions">
                <button class="btn sm ghost" type="button" data-act="edit" data-mid="${m.id}">${t('common.edit')}</button>
                <button class="btn sm ghost" type="button" data-act="delete" data-mid="${m.id}">${t('common.delete')}</button>
              </div>
            </div>`)}
        </div>`}

      <div class="section-head"><h2>${t('chat.justThisChat')}</h2><span class="meta">${t('memory.notSaved')}</span></div>
      <div class="card sunken">
        <p class="card-desc">${t('memory.justChatBody')}</p>
      </div>

      <p class="tiny center mt-24">${t('memory.footer')}</p>
      <div style="height:12px"></div>
    </div>
  </div>`;
}, {
  onMount: (root) => mountMemory(root),
});

export async function mountMemory(root) {
  const settings = state.memorySettings || {};
  const version = settings.version || 1;

  root.querySelectorAll('[data-switch]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const key = sw.getAttribute('data-switch');
      const next = sw.getAttribute('aria-checked') !== 'true';
      // 每次点击都重新读版本号：连着改两次时，第一次成功后服务端 version 已经 +1，
      // 沿用闭包里的旧值第二次必然 409，而用户看到的只是"开关又弹回去了"。
      const current = (state.memorySettings && state.memorySettings.version) || version;
      sw.setAttribute('aria-checked', String(next));
      try {
        const fresh = await api.patch('/settings/memory', { [key]: next, version: current });
        state.memorySettings = fresh;
        toast(next ? t('memory.toastOn') : t('memory.toastOff'));
        await loadSession().catch(() => {});
      } catch (err) {
        if (err && err.status === 409) {
          const fresh = await api.get('/settings/memory').catch(() => null);
          if (fresh) {
            state.memorySettings = fresh;
            sw.setAttribute('aria-checked', String(fresh[key] === true || fresh[key] === 1));
          }
          toast(t('memory.toastConflict'), 'error');
          return;
        }
        sw.setAttribute('aria-checked', String(!next));
        toast(err.display || err.message || t('memory.saveFail'), 'error');
      }
    });
  });

  root.querySelectorAll('[data-pact]').forEach((b) => {
    b.addEventListener('click', async () => {
      const pid = b.getAttribute('data-pid');
      const decision = b.getAttribute('data-pact');
      try {
        await api.post(`/memory-proposals/${pid}/decision`, { decision });
        const card = root.querySelector(`[data-pid="${pid}"]`);
        if (card) {
          card.classList.remove('pending');
          card.innerHTML = `<div class="top"><span class="badge">${decision === 'confirm' ? t('memory.confirmed') : t('chat.labelNotSaved')}</span></div>
            <div class="text">${card.querySelector('.text').textContent}</div>`;
        }
        await loadSession().catch(() => {});
        toast(decision === 'confirm' ? t('memory.toastRemembered') : t('memory.toastNotSaved'), 'good');
        if (decision === 'confirm') setTimeout(() => go('memory'), 500);
      } catch (err) {
        toast(err.display || err.message || t('memory.toastSaveFail'), 'error');
      }
    });
  });

  root.querySelectorAll('[data-act="edit"]').forEach((b) => {
    b.addEventListener('click', () => {
      const mid = b.getAttribute('data-mid');
      const card = root.querySelector(`[data-mid="${mid}"]`);
      const current = card.querySelector('.text').textContent;
      openSheet({
        title: t('memory.editTitle'),
        body: `<p class="sub">${t('memory.editBody')}</p>
          <textarea class="field mt-16" id="mem-text" maxlength="240">${escapeHtml(current)}</textarea>`,
        actions: [
          { label: t('common.save'), kind: 'accent', onClick: async () => {
              const val = document.getElementById('mem-text').value.trim();
              const list = await api.get('/memories');
              const row = (list.items || []).find((m) => m.id === mid);
              if (!row) return;
              try {
                await api.patch(`/memories/${mid}`, { content: val, version: row.version });
                toast(t('memory.editUpdated'), 'good');
                go('memory');
              } catch (err) {
                toast(err.display || err.message || t('memory.editFail'), 'error');
              }
            } },
          { label: t('common.cancel'), kind: 'ghost' },
        ],
      });
    });
  });

  root.querySelectorAll('[data-act="delete"]').forEach((b) => {
    b.addEventListener('click', async () => {
      const mid = b.getAttribute('data-mid');
      const ok = await confirmSheet({
        title: t('memory.deleteTitle'),
        body: `<p class="sub">${t('memory.deleteBody')}</p>`,
        confirmLabel: t('memory.deleteConfirm'),
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/memories/${mid}`);
        const card = root.querySelector(`[data-mid="${mid}"]`);
        if (card) card.remove();
        toast(t('memory.deleted'), 'good');
      } catch (err) {
        toast(err.display || err.message || t('memory.deleteFail'), 'error');
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ----------------------------------------------------------- relationship */

route('relationship', () => {
  if (!state.me || !state.companion) return html`<div class="screen">${loadingBlock()}</div>`;
  const comp = state.companion;
  const types = [
    { id: 'friend', glyph: '♡' },
    { id: 'mentor', glyph: '✦' },
    { id: 'family', glyph: '⌂' },
    { id: 'custom', glyph: '◌' },
  ];
  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'profile', eyebrow: t('relationship.eyebrow'), title: '' })}
      <h2 class="display h2 mt-16">${t('relationship.heading', { name: comp.name })}</h2>
      <p class="sub">${t('relationship.sub')}</p>

      <div class="rel-grid" id="rel-grid">
        ${types.map((x) => html`
          <button class="rel-card" type="button" data-rel="${x.id}"
            aria-pressed="${(comp.relationship_type || 'friend') === x.id}">
            <span class="glyph">${x.glyph}</span>
            <strong>${t(`rel.${x.id}`)}</strong>
            <small>${t(`rel.${x.id}Desc`)}</small>
          </button>`)}
      </div>

      <div class="field-error" id="rel-error" role="alert" hidden></div>
      <button class="btn accent block lg mt-24" id="rel-save">${t('relationship.save')}</button>
      <div style="height:12px"></div>
    </div>
  </div>`;
}, {
  onMount: (root) => {
    const stillHere = mountGuard();
    let chosen = (state.companion && state.companion.relationship_type) || 'friend';
    root.querySelectorAll('[data-rel]').forEach((b) => {
      b.addEventListener('click', () => {
        chosen = b.getAttribute('data-rel');
        root.querySelectorAll('[data-rel]').forEach((x) => {
          x.setAttribute('aria-pressed', String(x === b));
        });
      });
    });
    root.querySelector('#rel-save').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await api.patch(`/companions/${state.companion.id}`, {
          relationship_type: chosen,
          version: state.companion.version,
        });
        await loadSession();
        toast(t('relationship.updated'), 'good');
        if (stillHere()) go('profile');
      } catch (err) {
        const e = root.querySelector('#rel-error');
        e.textContent = err.display || err.message || t('relationship.err');
        e.hidden = false;
        btn.disabled = false;
      }
    });
  },
});

/* ---------------------------------------------------------------- privacy */

route('privacy', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const settings = await api.get('/settings/memory').catch(() => state.memorySettings || {});
  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'profile', eyebrow: t('privacy.eyebrow'), title: '' })}
      <div class="privacy-hero">
        <div class="glyph">${icon('shield')}</div>
        <h2>${t('privacy.heading1')}<br>${t('privacy.heading2')}</h2>
        <p>${t('privacy.sub')}</p>
      </div>

      <div class="settings-group">
        <div class="setting">
          <span class="label">${t('memory.extraction')}<small>${t('memory.extractionSub')}.</small></span>
          <button class="toggle" role="switch" data-switch="extraction_enabled"
            aria-checked="${settings.extraction_enabled ? 'true' : 'false'}"
            aria-label="${t('memory.extraction')}"></button>
        </div>
        <div class="setting">
          <span class="label">${t('memory.retrieval')}<small>${t('memory.retrievalSub')}.</small></span>
          <button class="toggle" role="switch" data-switch="retrieval_enabled"
            aria-checked="${settings.retrieval_enabled ? 'true' : 'false'}"
            aria-label="${t('memory.retrieval')}"></button>
        </div>
      </div>

      <div class="settings-group mt-16">
        <button class="setting" type="button" data-act="export">
          <span class="label">${t('privacy.export')}<small>${t('privacy.exportSub')}</small></span>
          ${icon('download')}
        </button>
        <button class="setting" type="button" data-act="growth-reset">
          <span class="label">${t('privacy.reset')}<small>${t('privacy.resetSub')}</small></span>
          ${icon('refresh')}
        </button>
        <button class="setting danger" type="button" data-act="delete">
          <span class="label">${t('privacy.delete')}<small>${t('privacy.deleteSub')}</small></span>
          ${icon('chev')}
        </button>
      </div>

      <div class="inline-note mt-16">
        <span>${icon('info')}</span>
        <span>${t('privacy.storeNote')}</span>
      </div>

      <p class="tiny center mt-24" style="line-height:1.7">
        ${t('privacy.collect')}
      </p>
      <div style="height:12px"></div>
    </div>
  </div>`;
}, {
  onMount: (root) => {
    root.querySelectorAll('[data-switch]').forEach((sw) => {
      sw.addEventListener('click', async () => {
        const key = sw.getAttribute('data-switch');
        const next = sw.getAttribute('aria-checked') !== 'true';
        // 同上：版本号必须现读，不能捕获在闭包里。
        const current = (state.memorySettings && state.memorySettings.version) || 1;
        sw.setAttribute('aria-checked', String(next));
        try {
          state.memorySettings = await api.patch('/settings/memory', { [key]: next, version: current });
          toast(next ? t('memory.toastOn') : t('memory.toastOff'));
          await loadSession().catch(() => {});
        } catch (err) {
          if (err && err.status === 409) {
            const fresh = await api.get('/settings/memory').catch(() => null);
            if (fresh) {
              state.memorySettings = fresh;
              sw.setAttribute('aria-checked', String(fresh[key] === true || fresh[key] === 1));
            }
            toast(t('memory.toastConflict'), 'error');
            return;
          }
          sw.setAttribute('aria-checked', String(!next));
          toast(err.display || err.message || t('memory.saveFail'), 'error');
        }
      });
    });

    root.querySelector('[data-act="export"]').addEventListener('click', () => {
      openSheet({
        title: t('privacy.exportTitle'),
        body: `<p class="sub">${t('privacy.exportBody')}</p>
          <input class="field mt-16" id="exp-pass" type="password" placeholder="${t('auth.password')}" autocomplete="current-password">`,
        actions: [
          { label: t('privacy.prepareExport'), kind: 'accent', onClick: async () => {
              const password = document.getElementById('exp-pass').value;
              try {
                const res = await api.post('/exports', { password });
                const payload = await api.get(`/jobs/${res.job_id}/download`);
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'withyou-export.json';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 4000);
                toast(t('privacy.exportReady'), 'good');
              } catch (err) {
                toast(err.display || err.message || t('privacy.exportFail'), 'error');
              }
            } },
          { label: t('common.cancel'), kind: 'ghost' },
        ],
      });
    });

    root.querySelector('[data-act="growth-reset"]').addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: t('privacy.resetTitle'),
        body: `<p class="sub">${t('privacy.resetBody')}</p>`,
        confirmLabel: t('privacy.resetConfirm'),
        danger: true,
      });
      if (!ok) return;
      try {
        await api.post('/growth/reset', { confirm: true });
        await loadSession();
        toast(t('privacy.resetDone'), 'good');
      } catch (err) {
        toast(err.display || err.message || t('privacy.resetFail'), 'error');
      }
    });

    root.querySelector('[data-act="delete"]').addEventListener('click', () => {
      openSheet({
        title: t('privacy.deleteTitle'),
        body: `<p class="sub">${t('privacy.deleteBody1')}</p>
          <p class="sub mt-12">${t('privacy.deleteBody2')}</p>
          <label class="field-label mt-16" for="del-pass">${t('privacy.deleteConfirmLabel')}</label>
          <input class="field" id="del-pass" type="password" placeholder="${t('auth.password')}" autocomplete="current-password">`,
        actions: [
          { label: t('privacy.deleteEverything'), kind: 'danger', onClick: async () => {
              const password = document.getElementById('del-pass').value;
              if (!password) { toast(t('privacy.enterPassword'), 'error'); return true; }
              try {
                const result = await requestDelete(password);
                toast(t('privacy.deletionStarted'), 'good');
                setTimeout(async () => {
                  const { setToken } = await import('../api.js');
                  setToken(null);
                  const { forgetUserState } = await import('../app.js');
                  forgetUserState();
                  go('welcome');
                }, 1400);
              } catch (err) {
                toast(err.display || err.message || t('privacy.deleteFail'), 'error');
              }
            } },
          { label: t('privacy.keepAccount'), kind: 'ghost' },
        ],
      });
    });
  },
});

async function requestDelete(password) {
  const { request } = await import('../api.js');
  return request('DELETE', '/account', { confirmation: true, password });
}

/* ------------------------------------------------------------------- plus */

route('plus', async () => {
  const sub = await api.get('/subscription').catch(() => null);
  const products = (sub && sub.products) || [];
  const status = sub ? sub.status : 'none';
  const entitled = ['active', 'trial', 'grace'].includes(status);
  const monthly = products.find((p) => p.period === 'month');
  const yearly = products.find((p) => p.period === 'year');

  return html`
  <div class="screen">
    <div class="scroll no-nav">
      <div class="plus-hero">
        <div class="row between">
          <span class="eyebrow">${t('plus.eyebrow')}</span>
          <button class="icon-btn" type="button" data-go="profile" aria-label="${t('common.close')}" style="color:#fff">${icon('close')}</button>
        </div>
        <h1>${t('plus.heading1')}<br>${t('plus.heading2')}</h1>
        <p>${t('plus.sub')}</p>
      </div>

      <div class="benefits">
        <div class="benefit"><span class="glyph">∞</span><b>${t('plus.benefit1')}</b><small>${t('plus.benefit1Desc')}</small></div>
        <div class="benefit"><span class="glyph">◈</span><b>${t('plus.benefit2')}</b><small>${t('plus.benefit2Desc')}</small></div>
        <div class="benefit"><span class="glyph">♫</span><b>${t('plus.benefit3')}</b><small>${t('plus.benefit3Desc')}</small></div>
      </div>

      ${entitled ? html`
        <div class="card wash">
          <div class="card-title" style="color:#3f3a72">${subscriptionLabel(sub)}</div>
          <p class="card-desc" style="color:#4c4794">
            ${sub.entitlement_end_at ? t('plus.accessUntil', { date: prettyDate(sub.entitlement_end_at) }) : t('plus.active')}
            ${status === 'canceled' ? t('plus.renewalOff') : ''}
          </p>
        </div>
        <div class="stack mt-16">
          ${status !== 'canceled' ? html`<button class="btn ghost block" type="button" data-act="cancel">${t('plus.cancelBtn')}</button>` : ''}
          <button class="btn link block" type="button" data-act="restore">${t('plus.restore')}</button>
        </div>`
      : html`
        <div class="stack mt-16">
          ${monthly ? html`
            <button class="plan-card" type="button" data-plan="${monthly.id}" aria-pressed="true" id="plan-monthly">
              <div class="row between">
                <div>
                  <b style="font-size:14px">${tf('plus.planMonthly', monthly.title)}</b>
                  <p class="card-desc">${monthly.trial_days ? t('plus.trialLine', { days: monthly.trial_days }) : t('plus.billedMonthly')}</p>
                </div>
                <span class="price">$${monthly.price}<small>${t('plus.perMonth')}</small></span>
              </div>
            </button>` : ''}
          ${yearly ? html`
            <button class="plan-card" type="button" data-plan="${yearly.id}" aria-pressed="false" id="plan-yearly">
              <div class="row between">
                <div>
                  <b style="font-size:14px">${tf('plus.planYearly', yearly.title)}</b>
                  <p class="card-desc">${t('plus.billedYearly')}</p>
                </div>
                <span class="price">$${yearly.price}<small>${t('plus.perYear')}</small></span>
              </div>
            </button>` : ''}
        </div>
        <div class="field-error mt-12" id="plus-error" role="alert" hidden></div>
        <button class="btn accent block lg mt-16" id="plus-buy">${t('plus.startTrial')}</button>
        <p class="legal-note">${t('plus.legal')}</p>`}

      <div class="divider"></div>
      <p class="tiny center" style="line-height:1.7">
        ${t('plus.note')}
      </p>
      <div style="height:12px"></div>
    </div>
  </div>`;
}, {
  onMount: (root) => {
    const stillHere = mountGuard();
    let chosen = 'withyou_plus_monthly';
    root.querySelectorAll('[data-plan]').forEach((b) => {
      b.addEventListener('click', () => {
        chosen = b.getAttribute('data-plan');
        root.querySelectorAll('[data-plan]').forEach((x) => {
          x.setAttribute('aria-pressed', String(x === b));
        });
        const buy = root.querySelector('#plus-buy');
        if (buy) buy.textContent = chosen === 'withyou_plus_yearly' ? t('plus.subscribeYearly') : t('plus.startTrial');
      });
    });

    const buy = root.querySelector('#plus-buy');
    if (buy) {
      buy.addEventListener('click', async () => {
        buy.disabled = true;
        buy.textContent = t('plus.contacting');
        const error = root.querySelector('#plus-error');
        error.hidden = true;
        try {
          const txn = 'mock-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          const res = await api.post('/purchases/verify', {
            platform: 'google',
            product_id: chosen,
            transaction_id: txn,
            receipt: 'mock-receipt-' + txn,
          });
          // Poll the order a few times; settlement runs in the background.
          let status = res.status;
          for (let i = 0; i < 12 && status === 'pending'; i += 1) {
            await new Promise((r) => setTimeout(r, 350));
            const order = await api.get(`/orders/${res.order_id}`);
            status = order.status;
          }
          await loadSession();
          if (status === 'verified') {
            toast(t('plus.activated'), 'good');
            if (stillHere()) go('plus');
          } else if (status === 'failed') {
            error.textContent = t('plus.failed');
            error.hidden = false;
          } else {
            error.textContent = t('plus.pending');
            error.hidden = false;
          }
        } catch (err) {
          error.textContent = err.display || err.message || t('plus.failGeneric');
          error.hidden = false;
        } finally {
          buy.disabled = false;
          buy.textContent = t('plus.startTrial');
        }
      });
    }

    const cancel = root.querySelector('[data-act="cancel"]');
    if (cancel) {
      cancel.addEventListener('click', async () => {
        const ok = await confirmSheet({
          title: t('plus.cancelTitle'),
          body: `<p class="sub">${t('plus.cancelBody')}</p>`,
          confirmLabel: t('plus.cancelConfirm'),
          danger: true,
          cancelLabel: t('plus.keepPlus'),
        });
        if (!ok) return;
        try {
          await api.post('/subscription/cancel', {});
          await loadSession();
          toast(t('plus.canceled'), 'good');
          if (stillHere()) go('plus');
        } catch (err) {
          toast(err.display || err.message || t('plus.cancelFail'), 'error');
        }
      });
    }

    const restore = root.querySelector('[data-act="restore"]');
    if (restore) {
      restore.addEventListener('click', async () => {
        try {
          const res = await api.post('/subscription/restore', {});
          await loadSession();
          toast(res.restored ? t('plus.restored') : t('plus.noneFound'),
            res.restored ? 'good' : '');
          if (stillHere()) go('plus');
        } catch (err) {
          toast(err.display || err.message || t('plus.restoreFail'), 'error');
        }
      });
    }
  },
});