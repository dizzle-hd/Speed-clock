(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const B = BigInt;

  /* ================= Einheiten =================
   * Alle Zeiten sind exakte Ganzzahlen (BigInt) in Attosekunden (1 as = 10^-18 s).
   * Dadurch sind Auto-Runden bis 1 as möglich = 1 Trillion (10^18) Runden pro Sekunde,
   * ohne Rundungsfehler und ohne Obergrenze bei der Rundenzahl.
   */
  const UNIT = { as: 1n, fs: 10n ** 3n, ps: 10n ** 6n, ns: 10n ** 9n, us: 10n ** 12n, ms: 10n ** 15n, s: 10n ** 18n, min: 60n * 10n ** 18n };
  const SEC = UNIT.s, MS = UNIT.ms;
  const UNIT_LABEL = [['min', 'min'], ['s', 's'], ['ms', 'ms'], ['us', 'µs'], ['ns', 'ns'], ['ps', 'ps'], ['fs', 'fs'], ['as', 'as']];
  const perfToAs = ms => B(Math.round(ms * 1e6)) * UNIT.ns;   // performance.now()-ms → as
  const bmin = (a, b) => (a < b ? a : b), bmax = (a, b) => (a > b ? a : b);

  /* ================= Einstellungen ================= */
  const CFG_KEY = 'speedclock.cfg.v4', OLD_CFG_KEY = 'speedclock.cfg.v3', SESSION_KEY = 'speedclock.session.v4';
  const DEFAULTS = {
    intVal: '1', intUnit: 'as', autoOnStart: false, maxLaps: '0', debounce: '0',
    durH: '0', durM: '0', durS: '0', delay: '0',
    theme: 'auto', accent: '#3ddc97', decimals: 'auto', rows: '20', showList: true, showHints: true,
    beep: true, volume: 0.5, vibrate: true, wake: true,
    csvMax: '100000', restore: true, pinHash: '',
  };
  let CFG = { ...DEFAULTS };
  const COPY_MAX = 10000;

  // Dezimalzahl (Komma oder Punkt) exakt in BigInt umrechnen
  function decTo(str, unit) {
    const s = String(str ?? '').trim().replace(',', '.');
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
    const [i, f = ''] = s.split('.');
    const fr = f.slice(0, 30);
    let v = B(i || '0') * unit + (fr ? B(fr) * unit / 10n ** B(fr.length) : 0n);
    if (v === 0n && /[1-9]/.test(s)) v = 1n;   // kleiner als 1 as → 1 as
    return v;
  }
  function intervalAs() { const v = decTo(CFG.intVal, UNIT[CFG.intUnit] || UNIT.ns); return v && v > 0n ? v : 0n; }
  function durationAs() {
    return (decTo(CFG.durH, 3600n * SEC) || 0n) + (decTo(CFG.durM, 60n * SEC) || 0n) + (decTo(CFG.durS, SEC) || 0n);
  }
  const maxLaps = () => { const d = String(CFG.maxLaps ?? '').replace(/\D/g, ''); return d ? B(d) : 0n; };
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch (e) {} }
  function loadCfg() {
    try {
      let o = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (!o) { // Migration von v3: alles übernehmen außer dem (zu langsamen) Intervall
        o = JSON.parse(localStorage.getItem(OLD_CFG_KEY) || 'null');
        if (o) { delete o.intVal; delete o.intUnit; }
      }
      if (o && typeof o === 'object') {
        CFG = { ...DEFAULTS, ...o };
        ['maxLaps', 'durH', 'durM', 'durS'].forEach(k => { CFG[k] = String(CFG[k]); });
      }
    } catch (e) {}
  }

  /* ================= Zustand =================
   * Runden werden nicht einzeln gespeichert, sondern als Abschnitte {i0, t0, dt, n, prev, man}:
   * Runde k endet bei t0 + (k+1)*dt, die erste ist (Ende - prev) lang.
   */
  const S = {
    running: false, startPerf: 0, elapsed: 0n, finished: false,
    runs: [], closed: 0n, closedTotal: 0n, auto: null, autoOn: false,
    viewTop: null, prec: 3, pre: null, lastManual: 0,
  };

  /* ================= Format ================= */
  const p2 = n => String(n).padStart(2, '0');
  function fmt(as, dec, floor) {
    const unit = 10n ** B(18 - dec);
    let v = floor ? as / unit : (as + unit / 2n) / unit;
    if (v < 0n) v = 0n;
    const sc = 10n ** B(dec), frac = v % sc;
    let s = v / sc;
    const h = s / 3600n, m = (s / 60n) % 60n; s %= 60n;
    return (h ? h + ':' + p2(m) : p2(m)) + ':' + p2(s) + '.' + frac.toString().padStart(dec, '0');
  }
  const precFor = dt => dt >= MS ? 3 : dt >= UNIT.us ? 6 : dt >= UNIT.ns ? 9 : dt >= UNIT.ps ? 12 : dt >= UNIT.fs ? 15 : 18;
  const dec = () => CFG.decimals === 'auto' ? S.prec : +CFG.decimals;
  const nf = new Intl.NumberFormat('de-DE');
  const fmtN = n => nf.format(n);
  function fmtInterval(as) {
    if (!as) return 'Intervall ungültig';
    for (const [k, lbl] of UNIT_LABEL) {
      const u = UNIT[k];
      if (as >= u || k === 'as') {
        const whole = as / u, rem = as % u;
        let fr = rem ? (rem * 1000000n / u).toString().padStart(6, '0').replace(/0+$/, '') : '';
        return fmtN(whole) + (fr ? ',' + fr : '') + ' ' + lbl;
      }
    }
  }
  const rateOf = dt => SEC / dt;

  /* ================= Feedback ================= */
  let audio;
  function beep(freq = 880, dur = 0.08, times = 1, force) {
    if (!CFG.beep && !force) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const vol = Math.max(0.0001, Math.min(1, +CFG.volume || 0) * 0.5);
      for (let i = 0; i < times; i++) {
        const t = audio.currentTime + i * (dur + 0.07);
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.start(t); o.stop(t + dur + 0.02);
      }
    } catch (e) {}
  }
  const vibrate = p => { try { if (CFG.vibrate && navigator.vibrate) navigator.vibrate(p); } catch (e) {} };
  function flash() { const d = $('display'); d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash'); }
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
  let wakeLock = null;
  async function wake(on) {
    try {
      if (on && CFG.wake && 'wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
    } catch (e) {}
  }

  /* ================= Kern ================= */
  const rawNow = () => S.running ? S.elapsed + perfToAs(performance.now() - S.startPerf) : S.elapsed;
  const openCount = t => (S.auto && t >= S.auto.t0) ? (t - S.auto.t0) / S.auto.dt : 0n;
  const lapCount = t => S.closed + openCount(t);
  const lastTotal = t => { const n = openCount(t); return n ? S.auto.t0 + n * S.auto.dt : S.closedTotal; };

  function getLap(i) {
    let r, k;
    if (i >= S.closed) { r = S.auto; k = i - S.closed; }
    else {
      let lo = 0, hi = S.runs.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (S.runs[mid].i0 <= i) lo = mid; else hi = mid - 1; }
      r = S.runs[lo]; k = i - r.i0;
    }
    const total = r.t0 + (k + 1n) * r.dt;
    return { total, lap: k === 0n ? total - r.prev : r.dt, man: !!r.man };
  }

  // Ende durch Dauer oder Rundenlimit (null = kein Ende)
  function endTime(raw) {
    let e = null;
    const d = durationAs(); if (d > 0n) e = d;
    const ml = maxLaps();
    if (ml > 0n) {
      const tt = e === null ? raw : bmin(raw, e);
      if (lapCount(tt) >= ml) { const lt = getLap(ml - 1n).total; e = e === null ? lt : bmin(e, lt); }
    }
    return e;
  }
  const now = () => { const r = rawNow(), e = endTime(r); return e !== null && r > e ? e : r; };

  function closeAuto(t) {
    if (!S.auto) return;
    const n = openCount(t);
    if (n > 0n) {
      S.runs.push({ i0: S.closed, t0: S.auto.t0, dt: S.auto.dt, n, prev: S.auto.prev, man: false });
      S.closed += n; S.closedTotal = S.auto.t0 + n * S.auto.dt;
    }
    S.auto = null;
  }
  function openAuto(anchor) {
    const dt = intervalAs();
    if (!S.autoOn || !dt) return;
    S.auto = { t0: anchor, dt, prev: S.closedTotal };
    S.prec = Math.max(S.prec, precFor(dt));
  }

  function start() {
    if (S.pre) { cancelPre(); return; }
    if (S.finished) reset();
    const r = rawNow(), e = endTime(r);
    if (e !== null && r >= e) return;
    const delay = +CFG.delay || 0;
    if (delay > 0 && S.elapsed === 0n && S.closed === 0n) { startPre(delay); return; }
    reallyStart();
  }
  function reallyStart() {
    if (CFG.autoOnStart && !S.autoOn && S.elapsed === 0n) setAuto(true, true);
    S.running = true; S.startPerf = performance.now();
    if (S.autoOn && !S.auto) openAuto(S.elapsed);
    beep(1200, 0.06); wake(true); updateUI(); saveSession(); requestAnimationFrame(tick);
  }
  function startPre(sec) { S.pre = { until: performance.now() + sec * 1000, last: sec + 1 }; updateUI(); requestAnimationFrame(preTick); }
  function preTick() {
    if (!S.pre) return;
    const left = (S.pre.until - performance.now()) / 1000;
    if (left <= 0) { S.pre = null; reallyStart(); return; }
    const c = Math.ceil(left);
    if (c !== S.pre.last) { S.pre.last = c; beep(660, 0.1); vibrate(40); }
    $('time').innerHTML = '-' + c + '<small>.' + (Math.floor((c - left) * 10) % 10) + '</small>';
    $('stateTxt').textContent = 'Start in ' + c + ' s';
    requestAnimationFrame(preTick);
  }
  function cancelPre() { S.pre = null; updateUI(); render(true); }

  function stop() {
    if (S.pre) { cancelPre(); return; }
    S.elapsed = now(); S.running = false; wake(false); updateUI(); render(true); saveSession();
  }
  function reset() {
    S.pre = null; S.running = false; S.elapsed = 0n; S.finished = false; S.runs = []; S.closed = 0n; S.closedTotal = 0n;
    S.auto = null; S.viewTop = null; S.prec = 3; lastBeepCount = 0n; S.lastManual = 0;
    wake(false); updateUI(); render(true); saveSession();
  }
  function lap() {
    if (!S.running) return;
    const deb = +CFG.debounce || 0, pn = performance.now();
    if (deb && pn - S.lastManual < deb) return;
    S.lastManual = pn;
    const t = now();
    closeAuto(t);
    if (t > S.closedTotal) {
      S.runs.push({ i0: S.closed, t0: S.closedTotal, dt: t - S.closedTotal, n: 1n, prev: S.closedTotal, man: true });
      S.closed += 1n; S.closedTotal = t;
    }
    openAuto(t);
    beep(880); vibrate(30); flash(); render(true); saveSession();
  }
  function setAuto(on, silent) {
    S.autoOn = on;
    const t = now();
    if (on) { if (!S.auto && (S.running || S.elapsed > 0n)) openAuto(t); }
    else closeAuto(t);
    updateUI(); if (!silent) { render(true); saveSession(); }
  }
  function finish(e) {
    S.elapsed = e; S.running = false; S.finished = true;
    beep(520, 0.25, 3); vibrate([200, 100, 200, 100, 400]);
    wake(false); updateUI(); render(true); saveSession();
  }

  function stats(t) {
    const n = lapCount(t); if (!n) return null;
    let best = null, worst = null, nb = 0n, nw = 0n;
    const one = (v, c) => {
      if (best === null || v < best) { best = v; nb = c; } else if (v === best) nb += c;
      if (worst === null || v > worst) { worst = v; nw = c; } else if (v === worst) nw += c;
    };
    const add = (r, cnt) => { one(r.t0 + r.dt - r.prev, 1n); if (cnt > 1n) one(r.dt, cnt - 1n); };
    for (const r of S.runs) add(r, r.n);
    const oc = openCount(t); if (oc) add(S.auto, oc);
    return { n, best, worst, avg: lastTotal(t) / n, markBest: nb === 1n, markWorst: nw === 1n };
  }

  function onLimitsChanged() {
    if (S.finished) { const e = endTime(S.elapsed + 1n); if (e === null || e > S.elapsed) S.finished = false; }
    if (S.running) { const r = rawNow(), e = endTime(r); if (e !== null && r >= e) finish(e); }
    updateUI(); render(true);
  }
  function onIntervalChanged() {
    if (S.auto) { closeAuto(now()); openAuto(S.closedTotal); }
    updateUI(); render(true);
  }

  /* ================= Sitzung sichern ================= */
  const ser = o => JSON.stringify(o, (k, v) => typeof v === 'bigint' ? { $b: v.toString() } : v);
  const deser = s => JSON.parse(s, (k, v) => v && typeof v === 'object' && typeof v.$b === 'string' ? B(v.$b) : v);
  function saveSession() {
    if (!CFG.restore || S.runs.length > 50000) return;
    try {
      localStorage.setItem(SESSION_KEY, ser({
        v: 4, wall: Date.now(), running: S.running, elapsed: now(), finished: S.finished,
        runs: S.runs, closed: S.closed, closedTotal: S.closedTotal, auto: S.auto, autoOn: S.autoOn, prec: S.prec,
      }));
    } catch (e) {}
  }
  function restoreSession() {
    if (!CFG.restore) return;
    try {
      const o = deser(localStorage.getItem(SESSION_KEY) || 'null');
      if (!o || o.v !== 4) return;
      Object.assign(S, { runs: o.runs || [], closed: o.closed || 0n, closedTotal: o.closedTotal || 0n, auto: o.auto || null,
        autoOn: !!o.autoOn, prec: o.prec || 3, finished: !!o.finished, elapsed: o.elapsed || 0n });
      if (o.running) {
        S.elapsed += B(Math.max(0, Date.now() - o.wall)) * MS;
        S.running = true; S.startPerf = performance.now();
        toast('Sitzung wiederhergestellt – die Uhr läuft weiter');
        wake(true);
      }
    } catch (e) { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} }
  }
  setInterval(() => { if (S.running) saveSession(); }, 1000);
  window.addEventListener('pagehide', saveSession);

  /* ================= Darstellung ================= */
  let lastTable = 0, lastBeepCount = 0n;
  const SLOW = 250n * MS;
  function tick() {
    if (!S.running) return;
    try {
      const r = rawNow(), e = endTime(r);
      if (e !== null && r >= e) { finish(e); return; }
      const c = lapCount(r);
      if (S.auto && S.auto.dt >= SLOW && c > lastBeepCount && lastBeepCount) { beep(660); vibrate(20); flash(); }
      lastBeepCount = c;
      render(false);
    } catch (err) { console.error(err); }
    if (!document.hidden) requestAnimationFrame(tick);
  }
  setInterval(() => { if (S.running && document.hidden) tick(); }, 250);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.running) { wake(true); requestAnimationFrame(tick); }
    if (document.visibilityState === 'hidden') saveSession();
  });

  function render(force) {
    if (S.pre) return;
    const t = now(), n = lapCount(t), d = durationAs(), ml = maxLaps();
    const f = fmt(t, 3, true), i = f.lastIndexOf('.');
    $('time').innerHTML = f.slice(0, i) + '<small>' + f.slice(i) + '</small>';
    $('lapCountBig').textContent = fmtN(n);
    $('lapTime').textContent = fmt(t - lastTotal(t), dec(), true);
    $('avgTile').textContent = n ? fmt(lastTotal(t) / n, dec()) : '–';
    const hasD = d > 0n, hasL = ml > 0n;
    $('progBox').hidden = !(hasD || hasL);
    if (hasD || hasL) {
      let frac = 0; const lbl = [];
      if (hasD) { frac = Number(t * 10000n / d) / 10000; lbl.push('Ziel ' + fmt(d, 3)); $('remain').textContent = fmt(d - t, 3); }
      else $('remain').textContent = fmtN(bmax(0n, ml - n)) + ' Rd.';
      if (hasL) { frac = Math.max(frac, Number(bmin(n, ml) * 10000n / ml) / 10000); lbl.push('Limit ' + fmtN(ml) + ' Rd.'); }
      $('progress').style.width = Math.min(100, frac * 100) + '%';
      $('limitLbl').textContent = lbl.join(' · ');
    }
    const ms = performance.now();
    if (CFG.showList && (force || ms - lastTable > 100)) { lastTable = ms; renderTable(t, n); }
    if (adminOpen && (force || ms - lastInfo > 400)) { lastInfo = ms; renderInfo(t, n); }
  }

  const rows = () => +CFG.rows || 20;
  function renderTable(t, n) {
    const R = B(rows());
    $('empty').hidden = n > 0n;
    let top = S.viewTop == null ? n - 1n : bmin(S.viewTop, n - 1n);
    top = bmax(top, bmin(R - 1n, n - 1n));
    if (S.viewTop != null) S.viewTop = top;
    $('btnLive').classList.toggle('live', S.viewTop == null);
    const st = stats(t), D = dec(), diff = st && fmt(st.best, D) !== fmt(st.worst, D);
    const mb = diff && st.markBest, mw = diff && st.markWorst;
    let html = '';
    for (let i = top; i > top - R && i >= 0n; i--) {
      const l = getLap(i);
      const cls = (mb && l.lap === st.best ? 'best ' : '') + (mw && l.lap === st.worst ? 'worst ' : '') + (l.man ? 'man' : '');
      html += `<tr class="${cls}"><td>${fmtN(i + 1n)}</td><td>${fmt(l.lap, D)}</td><td>${fmt(l.total, D)}</td></tr>`;
    }
    $('lapBody').innerHTML = html;
    $('pos').textContent = n ? `${fmtN(bmax(1n, top - R + 2n))}–${fmtN(top + 1n)} / ${fmtN(n)}` : '';
    if (st) { $('stBest').textContent = fmt(st.best, D); $('stWorst').textContent = fmt(st.worst, D); $('stAvg').textContent = fmt(st.avg, D); }
    else ['stBest', 'stAvg', 'stWorst'].forEach(k => { $(k).textContent = '–'; });
  }

  function updateUI() {
    const disp = $('display');
    disp.classList.toggle('running', S.running || !!S.pre);
    disp.classList.toggle('finished', S.finished);
    $('stateTxt').textContent = S.pre ? 'Gleich geht’s los' : S.running ? 'Läuft' : S.finished ? 'Ziel erreicht' : S.elapsed > 0n ? 'Pausiert' : 'Bereit';
    const b = $('btnStart');
    b.classList.toggle('running', S.running || !!S.pre);
    b.innerHTML = (S.running || S.pre)
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
    b.setAttribute('aria-label', S.running ? 'Stopp' : 'Start');
    $('btnLap').disabled = !S.running;
    const iv = intervalAs();
    const a = $('btnAuto');
    a.classList.toggle('on', S.autoOn); a.setAttribute('aria-pressed', S.autoOn);
    $('autoLbl').textContent = iv ? 'alle ' + fmtInterval(iv) + (iv < SEC ? ' · ' + fmtN(rateOf(iv)) + ' Runden/s' : '') : 'Intervall im Admin-Panel einstellen';
    const chip = $('autoChip');
    chip.classList.toggle('on', S.autoOn);
    chip.textContent = S.autoOn ? 'AUTO ' + fmtInterval(iv) : 'AUTO AUS';
    $$('#speedChips button').forEach(c => c.classList.toggle('on', CFG.intUnit === c.dataset.u && String(CFG.intVal) === c.dataset.v));
    $('lapsCard').hidden = !CFG.showList;
    document.querySelector('.hint').hidden = !CFG.showHints;
  }

  function scrollBy(r) {
    const n = lapCount(now()); if (!n) return;
    const R = B(rows());
    const cur = S.viewTop == null ? n - 1n : S.viewTop, nt = cur - B(r);
    S.viewTop = nt >= n - 1n ? null : bmax(bmin(R - 1n, n - 1n), nt);
    render(true);
  }

  /* ================= Export (in Etappen, friert nicht ein) ================= */
  let exporting = false;
  async function buildText(max, sep, onProgress) {
    const t = now(), n = lapCount(t), m = Number(bmin(n, B(max))), D = dec();
    const parts = ['Runde' + sep + 'Rundenzeit' + sep + 'Gesamt' + sep + 'Manuell\n'];
    const CH = 20000;
    for (let s = 0; s < m; s += CH) {
      const e = Math.min(m, s + CH), chunk = new Array(e - s);
      for (let i = s; i < e; i++) {
        const l = getLap(B(i));
        chunk[i - s] = (i + 1) + sep + fmt(l.lap, D) + sep + fmt(l.total, D) + sep + (l.man ? 'ja' : '');
      }
      parts.push(chunk.join('\n') + '\n');
      if (onProgress) onProgress(e / m);
      await new Promise(r => setTimeout(r, 0));
    }
    return { parts, n, m };
  }
  async function exportCsv() {
    if (exporting) return;
    if (!lapCount(now())) { toast('Noch keine Runden zum Exportieren'); return; }
    exporting = true;
    const btns = [$('btnCsv'), $('btnCsv2')], orig = btns.map(b => b.textContent);
    try {
      const { parts, n, m } = await buildText(+CFG.csvMax || 100000, ';', p => btns.forEach(b => { b.textContent = Math.round(p * 100) + ' %'; }));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }));
      a.download = 'speed-clock-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast(n > B(m) ? `CSV: erste ${fmtN(m)} von ${fmtN(n)} Runden (Limit im Admin-Panel)` : `CSV mit ${fmtN(m)} Runden gespeichert`);
    } catch (e) { toast('Export fehlgeschlagen'); }
    finally { btns.forEach((b, i) => { b.textContent = orig[i]; }); exporting = false; }
  }
  async function copyLaps() {
    if (exporting) return;
    if (!lapCount(now())) { toast('Noch keine Runden'); return; }
    exporting = true;
    try {
      const { parts, n, m } = await buildText(COPY_MAX, '\t');
      await navigator.clipboard.writeText(parts.join(''));
      toast(n > B(m) ? `Erste ${fmtN(m)} von ${fmtN(n)} Runden kopiert – für mehr CSV nutzen` : `${fmtN(m)} Runden kopiert`);
    } catch (e) { toast('Kopieren nicht möglich'); }
    finally { exporting = false; }
  }

  /* ================= Admin-Panel ================= */
  let adminOpen = false, unlocked = false, lastInfo = 0;
  async function hash(s) {
    try {
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('speedclock:' + s));
      return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
    } catch (e) { let h = 5381; for (const c of 'speedclock:' + s) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return 'x' + h; }
  }
  function openAdmin(tab) {
    if (CFG.pinHash && !unlocked) {
      $('pinModal').hidden = false; $('pinIn').value = ''; $('pinErr').textContent = '';
      setTimeout(() => $('pinIn').focus(), 30);
      openAdmin.pendingTab = tab; return;
    }
    if (tab) selectTab(tab);
    adminOpen = true; syncForm();
    $('admin').classList.add('open'); $('scrim').classList.add('open'); $('admin').setAttribute('aria-hidden', 'false');
    if (location.hash !== '#admin') history.replaceState(null, '', '#admin');
    render(true);
  }
  function closeAdmin() {
    adminOpen = false;
    $('admin').classList.remove('open'); $('scrim').classList.remove('open'); $('admin').setAttribute('aria-hidden', 'true');
    if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
  }
  async function checkPin() {
    if (await hash($('pinIn').value) === CFG.pinHash) { unlocked = true; $('pinModal').hidden = true; openAdmin(openAdmin.pendingTab); }
    else { $('pinErr').textContent = 'Falscher PIN'; $('pinIn').select(); vibrate(80); }
  }
  function selectTab(tab) {
    $$('#adminTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.admin section[data-panel]').forEach(s => { s.hidden = s.dataset.panel !== tab; });
  }
  function syncForm() {
    $$('.admin [data-k]').forEach(el => {
      const v = CFG[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
    $$('.admin [data-seg]').forEach(seg => $$('button', seg).forEach(b => b.classList.toggle('on', b.dataset.v === String(CFG[seg.dataset.seg]))));
    $$('#swatches button').forEach(b => b.classList.toggle('on', b.dataset.v === CFG.accent));
    $('cfgIntVal').classList.toggle('bad', !intervalAs());
    $('cfgMaxLaps').classList.toggle('bad', /[^\d\s.]/.test(CFG.maxLaps));
    $('pinState').textContent = CFG.pinHash ? 'PIN aktiv – das Panel ist geschützt.' : 'Kein PIN gesetzt – das Panel ist frei zugänglich.';
    $('btnPinDel').disabled = !CFG.pinHash;
  }
  function setCfg(k, v) {
    CFG[k] = v; saveCfg();
    if (k === 'intVal' || k === 'intUnit') { $('cfgIntVal').classList.toggle('bad', !intervalAs()); onIntervalChanged(); }
    else if (['durH', 'durM', 'durS', 'maxLaps'].includes(k)) onLimitsChanged();
    else if (k === 'theme' || k === 'accent') applyLook();
    else if (k === 'restore') { if (!v) { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} } else saveSession(); }
    else if (k === 'wake') wake(v && S.running);
    else { updateUI(); render(true); }
  }
  function setInterval2(v, u) {
    CFG.intVal = v; setCfg('intUnit', u); if (adminOpen) syncForm();
    if (!S.autoOn) setAuto(true);
    toast('Auto-Runden: alle ' + fmtInterval(intervalAs()) + ' · ' + fmtN(rateOf(intervalAs())) + ' Runden/s');
  }
  function applyLook() {
    const r = document.documentElement;
    if (CFG.theme === 'auto') r.removeAttribute('data-theme'); else r.dataset.theme = CFG.theme;
    r.style.setProperty('--accent', CFG.accent);
    const light = CFG.theme === 'light' || (CFG.theme === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
    document.querySelector('meta[name=theme-color]').content = light ? '#eef2f8' : '#070a11';
  }
  function renderInfo(t, n) {
    $('iLaps').textContent = fmtN(n);
    $('iTime').textContent = fmt(t, 3, true);
    $('iRuns').textContent = fmtN(S.runs.length + (S.auto ? 1 : 0));
    $('iMem').textContent = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : 'n/v';
  }

  $$('.admin [data-k]').forEach(el => {
    const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'range') v = +v;
      setCfg(el.dataset.k, v);
    });
  });
  $$('.admin [data-seg]').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setCfg(seg.dataset.seg, b.dataset.v); syncForm();
  }));
  $('swatches').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setCfg('accent', b.dataset.v); syncForm(); } });
  $('intPresets').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setInterval2(b.dataset.v, b.dataset.u); });
  $('speedChips').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setInterval2(b.dataset.v, b.dataset.u); });
  $('maxPresets').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setCfg('maxLaps', b.dataset.v); syncForm(); } });
  $('durPresets').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const s = +b.dataset.s;
    CFG.durH = String(Math.floor(s / 3600)); CFG.durM = String(Math.floor(s / 60) % 60); setCfg('durS', String(s % 60)); syncForm();
  });
  $('adminTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) selectTab(b.dataset.tab); });
  $('btnTestBeep').onclick = () => beep(880, 0.12, 2, true);
  $('btnCsv2').onclick = exportCsv;
  $('btnCopy2').onclick = copyLaps;
  $('btnResetCfg').onclick = () => {
    if (!confirm('Alle Einstellungen auf Standard zurücksetzen?')) return;
    CFG = { ...DEFAULTS, pinHash: CFG.pinHash }; saveCfg(); applyLook(); syncForm(); onIntervalChanged(); onLimitsChanged();
    toast('Einstellungen zurückgesetzt');
  };
  $('btnExportCfg').onclick = () => {
    const { pinHash, ...rest } = CFG;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rest, null, 2)], { type: 'application/json' }));
    a.download = 'speed-clock-einstellungen.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('btnImportCfg').onclick = () => $('fileCfg').click();
  $('fileCfg').onchange = async e => {
    try {
      const o = JSON.parse(await e.target.files[0].text());
      for (const k of Object.keys(DEFAULTS)) {
        if (k === 'pinHash' || !(k in o)) continue;
        if (typeof DEFAULTS[k] === 'string') CFG[k] = String(o[k]);
        else if (typeof o[k] === typeof DEFAULTS[k]) CFG[k] = o[k];
      }
      saveCfg(); applyLook(); syncForm(); onIntervalChanged(); onLimitsChanged(); toast('Einstellungen importiert');
    } catch (err) { toast('Datei ungültig'); }
    e.target.value = '';
  };
  $('btnPinSet').onclick = async () => {
    const v = $('pinNew').value.trim();
    if (!/^\d{4,8}$/.test(v)) { toast('PIN muss 4–8 Ziffern haben'); return; }
    CFG.pinHash = await hash(v); unlocked = true; saveCfg(); $('pinNew').value = ''; syncForm(); toast('PIN gesetzt');
  };
  $('btnPinDel').onclick = () => { CFG.pinHash = ''; saveCfg(); syncForm(); toast('PIN entfernt'); };
  $('pinOk').onclick = checkPin;
  $('pinCancel').onclick = () => { $('pinModal').hidden = true; };
  $('pinIn').addEventListener('keydown', e => { if (e.key === 'Enter') checkPin(); if (e.key === 'Escape') $('pinModal').hidden = true; });

  /* ================= Bedienung ================= */
  $('btnStart').onclick = () => (S.running ? stop() : start());
  $('btnLap').onclick = lap;
  $('btnReset').onclick = reset;
  $('btnAuto').addEventListener('click', e => {
    if (e.target.closest('#autoEdit') || !intervalAs()) { openAdmin('laps'); return; }
    setAuto(!S.autoOn);
  });
  $('btnAdmin').onclick = () => openAdmin();
  $('btnAdminClose').onclick = closeAdmin;
  $('scrim').onclick = closeAdmin;
  $('display').addEventListener('pointerdown', e => { if (e.button > 0) return; e.preventDefault(); S.running ? lap() : start(); });
  $('btnCsv').onclick = exportCsv;
  $('btnCopy').onclick = copyLaps;
  $('btnLive').onclick = () => { S.viewTop = null; render(true); };
  $('btnUp').onclick = () => scrollBy(-rows());
  $('btnDown').onclick = () => scrollBy(rows());
  $('tablewrap').addEventListener('wheel', e => {
    if (!lapCount(now())) return;
    e.preventDefault(); scrollBy(Math.sign(e.deltaY) * 3);
  }, { passive: false });
  let touchY = null;
  $('tablewrap').addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
  $('tablewrap').addEventListener('touchmove', e => {
    if (touchY == null || lapCount(now()) <= B(rows())) return;
    e.preventDefault();
    const r = Math.trunc((touchY - e.touches[0].clientY) / 34);
    if (r) { scrollBy(r); touchY -= r * 34; }
  }, { passive: false });
  $('gotoLap').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const d = e.target.value.replace(/\D/g, ''), n = lapCount(now());
    if (!d || !n) return;
    const v = B(d); if (v < 1n) return;
    const top = bmin(v - 1n + B(Math.floor(rows() / 2)), n - 1n);
    S.viewTop = top >= n - 1n ? null : top; render(true);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && adminOpen) { closeAdmin(); return; }
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { if (e.key === 'Enter' && e.target.id !== 'pinIn') e.target.blur(); return; }
    if (adminOpen || !$('pinModal').hidden) return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space' || e.key === 'l' || e.key === 'L') { e.preventDefault(); S.running ? lap() : start(); }
    else if (e.key === 'Enter') { e.preventDefault(); S.running ? stop() : start(); }
    else if (e.key === 'a' || e.key === 'A') { if (intervalAs()) setAuto(!S.autoOn); }
    else if (e.key === 'r' || e.key === 'R') reset();
    else if (e.key === 's' || e.key === 'S') openAdmin();
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#admin' && !adminOpen) openAdmin(); });
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyLook); } catch (e) {}

  /* ================= Start ================= */
  loadCfg(); applyLook(); restoreSession(); updateUI(); render(true);
  if (S.running) requestAnimationFrame(tick);
  if (location.hash === '#admin') openAdmin();
})();
