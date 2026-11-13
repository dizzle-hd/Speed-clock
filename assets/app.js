(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ================= Einstellungen ================= */
  const CFG_KEY = 'speedclock.cfg.v3', SESSION_KEY = 'speedclock.session.v3';
  const DEFAULTS = {
    intVal: '1', intUnit: 'us', autoOnStart: false, maxLaps: 0, debounce: '0',
    durH: 0, durM: 0, durS: '0', delay: '0',
    theme: 'auto', accent: '#3ddc97', decimals: 'auto', rows: '20', showList: true, showHints: true,
    beep: true, volume: 0.5, vibrate: true, wake: true,
    csvMax: '100000', restore: true, pinHash: '',
  };
  let CFG = { ...DEFAULTS };
  const UNIT_US = { us: 1, ms: 1e3, s: 1e6, min: 6e7 };
  const MIN_INT_US = 1;
  const COPY_MAX = 10000;

  const parseNum = v => { const n = parseFloat(String(v).trim().replace(',', '.')); return isFinite(n) && n >= 0 ? n : NaN; };
  function intervalUs() {
    const v = parseNum(CFG.intVal);
    if (!(v > 0)) return 0;
    return Math.max(MIN_INT_US, v * (UNIT_US[CFG.intUnit] || 1));
  }
  function durationUs() {
    const s = (parseNum(CFG.durH) || 0) * 3600 + (parseNum(CFG.durM) || 0) * 60 + (parseNum(CFG.durS) || 0);
    return Math.min(s * 1e6, 1e15);
  }
  const maxLaps = () => Math.floor(parseNum(CFG.maxLaps) || 0);
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch (e) {} }
  function loadCfg() {
    try { const o = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); if (o && typeof o === 'object') CFG = { ...DEFAULTS, ...o }; } catch (e) {}
  }

  /* ================= Zustand =================
   * Alle Zeiten in Mikrosekunden. Runden werden nicht einzeln gespeichert, sondern als
   * Abschnitte {i0, t0, dt, n, prev, man}: Runde k endet bei t0 + (k+1)*dt, die erste
   * ist (Ende - prev) lang. Milliarden Auto-Runden kosten so nur wenige Bytes.
   */
  const S = {
    running: false, startPerf: 0, elapsed: 0, finished: false,
    runs: [], closed: 0, closedTotal: 0, auto: null, autoOn: false,
    viewTop: null, small: false, pre: null, lastManual: 0,
  };

  /* ================= Format ================= */
  const p2 = n => String(n).padStart(2, '0');
  function fmt(us, dec, floor) {
    const unit = 10 ** (6 - dec);
    let v = floor ? Math.floor(us / unit + 1e-7) : Math.round(us / unit);
    if (!isFinite(v) || v < 0) v = 0;
    const scale = 10 ** dec, frac = v % scale;
    let s = Math.floor(v / scale);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; s %= 60;
    return (h ? h + ':' + p2(m) : p2(m)) + ':' + p2(s) + '.' + String(frac).padStart(dec, '0');
  }
  const dec = () => CFG.decimals === 'auto' ? (S.small ? 6 : 3) : +CFG.decimals;
  const nf = new Intl.NumberFormat('de-DE'), nf6 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 6 });
  const fmtN = n => nf.format(n);
  function fmtInterval(us) {
    if (!us) return 'Intervall ungültig';
    if (us < 1e3) return nf6.format(us) + ' µs';
    if (us < 1e6) return nf6.format(us / 1e3) + ' ms';
    if (us < 6e7) return nf6.format(us / 1e6) + ' s';
    return nf6.format(us / 6e7) + ' min';
  }

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
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }
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
  const rawNow = () => S.running ? S.elapsed + (performance.now() - S.startPerf) * 1000 : S.elapsed;
  const openCount = t => S.auto ? Math.max(0, Math.floor((t - S.auto.t0) / S.auto.dt + 1e-9)) : 0;
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
    const total = r.t0 + (k + 1) * r.dt;
    return { total, lap: k === 0 ? total - r.prev : r.dt, man: !!r.man };
  }

  // Zeitpunkt, an dem die Uhr endet (Dauer oder Rundenlimit)
  function endTime(raw) {
    let e = Infinity;
    const d = durationUs(); if (d > 0) e = d;
    const ml = maxLaps();
    if (ml > 0 && lapCount(Math.min(raw, e)) >= ml) e = Math.min(e, getLap(ml - 1).total);
    return e;
  }
  const now = () => { const r = rawNow(); return Math.min(r, endTime(r)); };

  function closeAuto(t) {
    if (!S.auto) return;
    const n = openCount(t);
    if (n > 0) {
      S.runs.push({ i0: S.closed, t0: S.auto.t0, dt: S.auto.dt, n, prev: S.auto.prev, man: false });
      S.closed += n; S.closedTotal = S.auto.t0 + n * S.auto.dt;
    }
    S.auto = null;
  }
  function openAuto(anchor) {
    const dt = intervalUs();
    if (!S.autoOn || !dt) return;
    S.auto = { t0: anchor, dt, prev: S.closedTotal };
    if (dt < 1000) S.small = true;
  }

  function start() {
    if (S.pre) { cancelPre(); return; }
    if (S.finished) reset();
    if (rawNow() >= endTime(rawNow())) return;
    const delay = +CFG.delay || 0;
    if (delay > 0 && S.elapsed === 0 && !S.closed) { startPre(delay); return; }
    reallyStart();
  }
  function reallyStart() {
    if (CFG.autoOnStart && !S.autoOn && S.elapsed === 0) setAuto(true, true);
    S.running = true; S.startPerf = performance.now();
    if (S.autoOn && !S.auto) openAuto(S.elapsed);
    beep(1200, 0.06); wake(true); updateUI(); saveSession(); requestAnimationFrame(tick);
  }
  function startPre(sec) {
    S.pre = { until: performance.now() + sec * 1000, last: sec + 1 };
    updateUI(); requestAnimationFrame(preTick);
  }
  function preTick() {
    if (!S.pre) return;
    const left = (S.pre.until - performance.now()) / 1000;
    if (left <= 0) { S.pre = null; reallyStart(); return; }
    const c = Math.ceil(left);
    if (c !== S.pre.last) { S.pre.last = c; beep(660, 0.1); vibrate(40); }
    $('time').innerHTML = '-' + c + '<small>.' + String(Math.floor((c - left) * 10) % 10) + '</small>';
    $('stateTxt').textContent = 'Start in ' + c + ' s';
    requestAnimationFrame(preTick);
  }
  function cancelPre() { S.pre = null; updateUI(); render(true); }

  function stop() {
    if (S.pre) { cancelPre(); return; }
    S.elapsed = now(); S.running = false; wake(false); updateUI(); render(true); saveSession();
  }
  function reset() {
    S.pre = null; S.running = false; S.elapsed = 0; S.finished = false; S.runs = []; S.closed = 0; S.closedTotal = 0;
    S.auto = null; S.viewTop = null; S.small = false; lastBeepCount = 0; S.lastManual = 0;
    wake(false); updateUI(); render(true); saveSession();
  }
  function lap() {
    if (!S.running) return;
    const deb = +CFG.debounce || 0, pn = performance.now();
    if (deb && pn - S.lastManual < deb) return;
    S.lastManual = pn;
    const t = now();
    closeAuto(t);
    if (t - S.closedTotal >= 0.5) {
      S.runs.push({ i0: S.closed, t0: S.closedTotal, dt: t - S.closedTotal, n: 1, prev: S.closedTotal, man: true });
      S.closed++; S.closedTotal = t;
    }
    openAuto(t);
    beep(880); vibrate(30); flash(); render(true); saveSession();
  }
  function setAuto(on, silent) {
    S.autoOn = on;
    const t = now();
    if (on) { if (!S.auto && (S.running || S.elapsed > 0)) openAuto(t); }
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
    let best = Infinity, worst = 0, nb = 0, nw = 0;
    const one = (v, c) => {
      if (v < best) { best = v; nb = c; } else if (v === best) nb += c;
      if (v > worst) { worst = v; nw = c; } else if (v === worst) nw += c;
    };
    const add = (r, cnt) => { one(r.t0 + r.dt - r.prev, 1); if (cnt > 1) one(r.dt, cnt - 1); };
    for (const r of S.runs) add(r, r.n);
    const oc = openCount(t); if (oc) add(S.auto, oc);
    // Nur eindeutige Bestwerte hervorheben
    return { n, best, worst, avg: lastTotal(t) / n, markBest: nb === 1, markWorst: nw === 1 };
  }

  // Wenn Einstellungen das Limit verändern
  function onLimitsChanged() {
    if (S.finished && endTime(S.elapsed + 1) > S.elapsed) S.finished = false;
    if (S.running) { const r = rawNow(), e = endTime(r); if (r >= e) finish(e); }
    updateUI(); render(true);
  }
  function onIntervalChanged() {
    if (S.auto) { closeAuto(now()); openAuto(S.closedTotal); }
    updateUI(); render(true);
  }

  /* ================= Sitzung sichern ================= */
  function saveSession() {
    if (!CFG.restore || S.runs.length > 50000) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        v: 3, wall: Date.now(), running: S.running, elapsed: now(), finished: S.finished,
        runs: S.runs, closed: S.closed, closedTotal: S.closedTotal, auto: S.auto, autoOn: S.autoOn, small: S.small,
      }));
    } catch (e) {}
  }
  function restoreSession() {
    if (!CFG.restore) return;
    try {
      const o = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!o || o.v !== 3) return;
      Object.assign(S, { runs: o.runs || [], closed: o.closed || 0, closedTotal: o.closedTotal || 0, auto: o.auto || null,
        autoOn: !!o.autoOn, small: !!o.small, finished: !!o.finished, elapsed: o.elapsed || 0 });
      if (o.running) {
        S.elapsed += Math.max(0, Date.now() - o.wall) * 1000;
        S.running = true; S.startPerf = performance.now();
        toast('Sitzung wiederhergestellt – die Uhr läuft weiter');
        wake(true);
      }
    } catch (e) { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} }
  }
  setInterval(() => { if (S.running) saveSession(); }, 1000);
  window.addEventListener('pagehide', saveSession);

  /* ================= Darstellung ================= */
  let lastTable = 0, lastBeepCount = 0;
  function tick() {
    if (!S.running) return;
    try {
      const r = rawNow(), e = endTime(r);
      if (r >= e) { finish(e); return; }
      const c = lapCount(r);
      if (S.auto && S.auto.dt >= 250000 && c > lastBeepCount && lastBeepCount) { beep(660); vibrate(20); flash(); }
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
    const t = now(), n = lapCount(t), d = durationUs(), ml = maxLaps();
    const f = fmt(t, 3, true), i = f.lastIndexOf('.');
    $('time').innerHTML = f.slice(0, i) + '<small>' + f.slice(i) + '</small>';
    $('lapCountBig').textContent = fmtN(n);
    $('lapTime').textContent = fmt(t - lastTotal(t), dec(), true);
    $('avgTile').textContent = n ? fmt(lastTotal(t) / n, dec()) : '–';
    // Fortschritt: Dauer oder Rundenlimit
    const hasD = d > 0, hasL = ml > 0;
    $('progBox').hidden = !(hasD || hasL);
    if (hasD || hasL) {
      let frac = 0, lbl = [];
      if (hasD) { frac = t / d; lbl.push('Ziel ' + fmt(d, 3)); $('remain').textContent = fmt(d - t, 3); }
      else $('remain').textContent = fmtN(Math.max(0, ml - n)) + ' Rd.';
      if (hasL) { frac = Math.max(frac, n / ml); lbl.push('Limit ' + fmtN(ml) + ' Rd.'); }
      $('progress').style.width = Math.min(100, frac * 100) + '%';
      $('limitLbl').textContent = lbl.join(' · ');
    }
    const ms = performance.now();
    if (CFG.showList && (force || ms - lastTable > 100)) { lastTable = ms; renderTable(t, n); }
    if (adminOpen && (force || ms - lastInfo > 400)) { lastInfo = ms; renderInfo(t, n); }
  }

  function rows() { return +CFG.rows || 20; }
  function renderTable(t, n) {
    const R = rows();
    $('empty').hidden = n > 0;
    let top = S.viewTop == null ? n - 1 : Math.min(S.viewTop, n - 1);
    top = Math.max(top, Math.min(R - 1, n - 1));
    if (S.viewTop != null) S.viewTop = top;
    $('btnLive').classList.toggle('live', S.viewTop == null);
    const st = stats(t), D = dec(), diff = st && fmt(st.best, D) !== fmt(st.worst, D);
    const mb = diff && st.markBest, mw = diff && st.markWorst;
    let html = '';
    for (let i = top; i > top - R && i >= 0; i--) {
      const l = getLap(i);
      const cls = (mb && l.lap === st.best ? 'best ' : '') + (mw && l.lap === st.worst ? 'worst ' : '') + (l.man ? 'man' : '');
      html += `<tr class="${cls}"><td>${fmtN(i + 1)}</td><td>${fmt(l.lap, D)}</td><td>${fmt(l.total, D)}</td></tr>`;
    }
    $('lapBody').innerHTML = html;
    $('pos').textContent = n ? `${fmtN(Math.max(1, top - R + 2))}–${fmtN(top + 1)} / ${fmtN(n)}` : '';
    if (st) { $('stBest').textContent = fmt(st.best, D); $('stWorst').textContent = fmt(st.worst, D); $('stAvg').textContent = fmt(st.avg, D); }
    else ['stBest', 'stAvg', 'stWorst'].forEach(k => { $(k).textContent = '–'; });
  }

  function updateUI() {
    const disp = $('display');
    disp.classList.toggle('running', S.running || !!S.pre);
    disp.classList.toggle('finished', S.finished);
    $('stateTxt').textContent = S.pre ? 'Gleich geht’s los' : S.running ? 'Läuft' : S.finished ? 'Ziel erreicht' : S.elapsed > 0 ? 'Pausiert' : 'Bereit';
    const b = $('btnStart');
    b.classList.toggle('running', S.running || !!S.pre);
    b.innerHTML = (S.running || S.pre)
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
    b.setAttribute('aria-label', S.running ? 'Stopp' : 'Start');
    $('btnLap').disabled = !S.running;
    const iv = intervalUs();
    const a = $('btnAuto');
    a.classList.toggle('on', S.autoOn); a.setAttribute('aria-pressed', S.autoOn);
    $('autoLbl').textContent = iv ? 'alle ' + fmtInterval(iv) + (iv < 1e6 ? ' · ' + fmtN(Math.round(1e6 / iv)) + ' Runden/s' : '') : 'Intervall im Admin-Panel einstellen';
    const chip = $('autoChip');
    chip.classList.toggle('on', S.autoOn);
    chip.textContent = S.autoOn ? 'AUTO ' + fmtInterval(iv) : 'AUTO AUS';
    $('lapsCard').hidden = !CFG.showList;
    document.querySelector('.hint').hidden = !CFG.showHints;
  }

  function scrollBy(r) {
    const n = lapCount(now()); if (!n) return;
    const cur = S.viewTop == null ? n - 1 : S.viewTop, nt = cur - r;
    S.viewTop = nt >= n - 1 ? null : Math.max(Math.min(rows() - 1, n - 1), nt);
    render(true);
  }

  /* ================= Export (in Etappen, friert nicht ein) ================= */
  let exporting = false;
  async function buildText(max, sep, onProgress) {
    const t = now(), n = lapCount(t), m = Math.min(n, max), D = dec();
    const parts = ['Runde' + sep + 'Rundenzeit' + sep + 'Gesamt' + sep + 'Manuell\n'];
    const CH = 20000;
    for (let s = 0; s < m; s += CH) {
      const e = Math.min(m, s + CH), chunk = new Array(e - s);
      for (let i = s; i < e; i++) {
        const l = getLap(i);
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
      toast(n > m ? `CSV: erste ${fmtN(m)} von ${fmtN(n)} Runden (Limit im Admin-Panel)` : `CSV mit ${fmtN(m)} Runden gespeichert`);
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
      toast(n > m ? `Erste ${fmtN(m)} von ${fmtN(n)} Runden kopiert – für mehr CSV nutzen` : `${fmtN(m)} Runden kopiert`);
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
    if (await hash($('pinIn').value) === CFG.pinHash) {
      unlocked = true; $('pinModal').hidden = true; openAdmin(openAdmin.pendingTab);
    } else { $('pinErr').textContent = 'Falscher PIN'; $('pinIn').select(); vibrate(80); }
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
    $('cfgIntVal').classList.toggle('bad', !intervalUs());
    $('pinState').textContent = CFG.pinHash ? 'PIN aktiv – das Panel ist geschützt.' : 'Kein PIN gesetzt – das Panel ist frei zugänglich.';
    $('btnPinDel').disabled = !CFG.pinHash;
  }
  function setCfg(k, v) {
    CFG[k] = v; saveCfg();
    if (k === 'intVal' || k === 'intUnit') { $('cfgIntVal').classList.toggle('bad', !intervalUs()); onIntervalChanged(); }
    else if (['durH', 'durM', 'durS', 'maxLaps'].includes(k)) onLimitsChanged();
    else if (k === 'theme' || k === 'accent') applyLook();
    else if (k === 'restore') { if (!v) try { localStorage.removeItem(SESSION_KEY); } catch (e) {} else saveSession(); }
    else if (k === 'wake') wake(v && S.running);
    else { updateUI(); render(true); }
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

  // Formular-Bindings
  $$('.admin [data-k]').forEach(el => {
    const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      const k = el.dataset.k;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'range') v = +v;
      setCfg(k, v);
    });
  });
  $$('.admin [data-seg]').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setCfg(seg.dataset.seg, b.dataset.v); syncForm();
  }));
  $('swatches').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setCfg('accent', b.dataset.v); syncForm(); } });
  $('intPresets').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    CFG.intVal = b.dataset.v; setCfg('intUnit', b.dataset.u); syncForm();
    if (!S.autoOn) setAuto(true);
    toast('Auto-Runden: alle ' + fmtInterval(intervalUs()));
  });
  $('maxPresets').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setCfg('maxLaps', +b.dataset.v); syncForm(); } });
  $('durPresets').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const s = +b.dataset.s;
    CFG.durH = Math.floor(s / 3600); CFG.durM = Math.floor(s / 60) % 60; setCfg('durS', String(s % 60)); syncForm();
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
        if (typeof o[k] === typeof DEFAULTS[k] || ['durH', 'durM', 'maxLaps'].includes(k)) CFG[k] = o[k];
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
    if (e.target.closest('#autoEdit')) { openAdmin('laps'); return; }
    if (!intervalUs()) { openAdmin('laps'); return; }
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
    if (touchY == null || lapCount(now()) <= rows()) return;
    e.preventDefault();
    const r = Math.trunc((touchY - e.touches[0].clientY) / 34);
    if (r) { scrollBy(r); touchY -= r * 34; }
  }, { passive: false });
  $('gotoLap').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = parseInt(e.target.value.replace(/\D/g, ''), 10), n = lapCount(now());
    if (v >= 1 && n) { const top = Math.min(v - 1 + Math.floor(rows() / 2), n - 1); S.viewTop = top >= n - 1 ? null : top; render(true); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && adminOpen) { closeAdmin(); return; }
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { if (e.key === 'Enter' && e.target.id !== 'pinIn') e.target.blur(); return; }
    if (adminOpen || !$('pinModal').hidden) return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space' || e.key === 'l' || e.key === 'L') { e.preventDefault(); S.running ? lap() : start(); }
    else if (e.key === 'Enter') { e.preventDefault(); S.running ? stop() : start(); }
    else if (e.key === 'a' || e.key === 'A') { if (intervalUs()) setAuto(!S.autoOn); }
    else if (e.key === 'r' || e.key === 'R') reset();
    else if (e.key === 's' || e.key === 'S') openAdmin();
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#admin' && !adminOpen) openAdmin(); });
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyLook);

  /* ================= Start ================= */
  loadCfg(); applyLook(); restoreSession(); updateUI(); render(true);
  if (S.running) requestAnimationFrame(tick);
  if (location.hash === '#admin') openAdmin();
})();
