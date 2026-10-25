(function () {
  'use strict';

  // ---------- configuração ----------
  const BASE = 'https://resultados.tse.jus.br/oficial/ele2026';
  const ELE2 = '6258', ELE1 = '6257';
  const POLL_MS = 10000;
  const CF = '22', CL = '13';
  const LS = { hist: 'bol26_hist_v1', feed: 'bol26_feed_v1', t1: 'bol26_t1_v1', theme: 'bol26_theme' };
  const W_FULL = 30; // % de seções a partir do qual a UF "confia" só no próprio apurado

  const url = (ele, uf) => `${BASE}/${ele}/dados/${uf}/${uf}-c0001-e${ele.padStart(6, '0')}-u.json`;
  const $ = (id) => document.getElementById(id);
  const num = (s) => (s == null || s === '') ? 0 : parseFloat(String(s).replace(',', '.')) || 0;

  const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fInt = (v) => nf0.format(Math.round(v));
  const fP1 = (v) => nf1.format(v) + '%';
  const fP2 = (v) => nf2.format(v) + '%';
  const fPP = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + nf1.format(Math.abs(v)) + ' p.p.';
  const fMil = (v) => {
    const a = Math.abs(v);
    if (a >= 1e6) return nf2.format(v / 1e6).replace(/,?0+$/, '') + ' mi';
    if (a >= 1e3) return nf0.format(v / 1e3) + ' mil';
    return fInt(v);
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ---------- tema ----------
  (function theme() {
    const saved = store.get(LS.theme, null);
    if (saved) document.documentElement.dataset.theme = saved;
    $('themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const nx = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = nx;
      store.set(LS.theme, nx);
      renderAll();
    });
  })();

  // ---------- leitura do TSE ----------
  function parse(d) {
    const c = { [CF]: 0, [CL]: 0 };
    let eleito = null;
    for (const a of d.carg[0].agr) for (const p of a.par) for (const k of p.cand) {
      if (k.n in c) { c[k.n] = num(k.vap); if (k.e === 's') eleito = k.n; }
    }
    return {
      ht: d.ht, dt: d.dt, final: d.tf === 's',
      pst: num(d.s && d.s.pstn), te: num(d.e && d.e.te), est: num(d.e && d.e.est),
      comp: num(d.e && d.e.c), vv: num(d.v && d.v.vv), F: c[CF], L: c[CL], eleito,
    };
  }

  async function getJSON(u) {
    const r = await fetch(u, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // 1º turno: só Flávio e Lula, por UF. Busca uma vez e guarda.
  async function loadT1() {
    const c = store.get(LS.t1, null);
    if (c && Object.keys(c).length >= 28) return c;
    const out = {};
    await Promise.all(UFS.map(async ([uf]) => {
      try {
        const p = parse(await getJSON(url(ELE1, uf)));
        out[uf] = { F: p.F, L: p.L, vv: p.vv, te: p.te };
      } catch (e) {}
    }));
    if (Object.keys(out).length >= 28) store.set(LS.t1, out);
    return out;
  }

  // ---------- estado ----------
  const S = {
    br: null, uf: {}, prevUf: null, t1: {}, proj: null,
    hist: store.get(LS.hist, []), feed: store.get(LS.feed, []),
    mapMode: 'ap', sel: null, sort: { k: 'te', asc: false },
    sim: null, simTouched: false, lastHt: null, nextAt: 0, err: null,
  };

  // ---------- projeção ----------
  // Prior histórico por UF: 1º turno 2026 (Flávio × Lula entre os dois) e 2º turno 2022
  // (Bolsonaro × Lula), cada um deslocado pela variação observada contra ele na mesma
  // região, encolhida para a variação nacional quando a região tem pouco voto apurado.
  const K_SHRINK = 300000;   // votos: "peso" da variação nacional dentro de cada região
  const W_T1 = 0.6;          // peso do 1º turno 2026 no prior (2022 fica com 0,4)
  const share22 = (u) => { const r = T22[u]; return r ? r[1] / (r[0] + r[1]) : null; }; // fatia de Bolsonaro
  const share1 = (u) => { const b = S.t1[u]; return b && b.F + b.L > 0 ? b.F / (b.F + b.L) : null; };

  function swings(baseFn, U) {
    let n = 0, d = 0;
    const reg = {};
    for (const [u, , r] of UFS) {
      const a = U[u], b = baseFn(u);
      if (!a || b == null || a.F + a.L < 1) continue;
      const w = a.F + a.L, x = w * (a.F / w - b);
      n += x; d += w;
      (reg[r] = reg[r] || { n: 0, d: 0 }); reg[r].n += x; reg[r].d += w;
    }
    const nat = d ? n / d : 0;
    const out = { nat };
    for (const [, , r] of UFS) {
      const g = reg[r] || { n: 0, d: 0 };
      out[r] = (g.n + K_SHRINK * nat) / (g.d + K_SHRINK);
    }
    return out;
  }

  function prior(u, reg, sw1, sw22) {
    const b1 = share1(u), b22 = share22(u);
    const p1 = b1 == null ? null : b1 + sw1[reg];
    const p22 = b22 == null ? null : b22 + sw22[reg];
    let p = p1 != null && p22 != null ? W_T1 * p1 + (1 - W_T1) * p22 : (p1 ?? p22);
    return p == null ? null : Math.min(.98, Math.max(.02, p));
  }

  function project(U = S.uf, br = S.br) {
    const sw1 = swings(share1, U), sw22 = swings(share22, U);
    let PF = 0, PL = 0, REM = 0;
    const per = {};
    for (const [u, , reg] of UFS) {
      const a = U[u], b = S.t1[u];
      if (!a) continue;
      const w = Math.min(1, a.pst / W_FULL);
      const rate1 = b && b.te ? b.vv / b.te : 0.75;
      const rateA = a.est > 0 ? (a.F + a.L) / a.est : rate1;
      const rate = w * rateA + (1 - w) * rate1;
      const rem = a.pst >= 100 ? 0 : Math.max(0, (a.te - a.est) * rate);
      const cur = a.F + a.L > 0 ? a.F / (a.F + a.L) : null;
      const pri = prior(u, reg, sw1, sw22) ?? cur ?? .5;
      const share = cur == null ? pri : w * cur + (1 - w) * pri;
      const pf = a.F + rem * share, pl = a.L + rem * (1 - share);
      per[u] = { rem, share, prior: pri, pF: 100 * pf / (pf + pl || 1) };
      PF += pf; PL += pl; REM += rem;
    }
    const ok = br && br.pst >= 0.3;
    return { ok, swing: sw1.nat, swing22: sw22.nat, per, PF, PL, REM, pF: 100 * PF / (PF + PL || 1), remShareF: REM ? (PF - sum(U, 'F')) / REM : .5 };
  }
  function sum(U, k) { let s = 0; for (const u in U) s += U[u][k]; return s; }

  // ---------- ciclo ----------
  async function poll() {
    clearTimeout(poll.t);
    try {
      const br = parse(await getJSON(url(ELE2, 'br')));
      const changed = !S.br || br.ht !== S.br.ht || br.pst !== S.br.pst;
      const prevBr = S.br;
      S.br = br;
      if (changed || !Object.keys(S.uf).length) {
        const res = await Promise.allSettled(UFS.map(([uf]) => getJSON(url(ELE2, uf)).then((d) => [uf, parse(d)])));
        const prev = S.uf;
        const next = { ...S.uf };
        for (const r of res) if (r.status === 'fulfilled') next[r.value[0]] = r.value[1];
        S.prevUf = prev; S.uf = next;
        if (prevBr) diffFeed(prevBr, br, prev, next);
      }
      S.err = null;
      S.proj = project();
      record();
    } catch (e) {
      S.err = e.message || 'falha de rede';
    }
    renderAll();
    S.nextAt = Date.now() + POLL_MS;
    poll.t = setTimeout(poll, POLL_MS);
  }

  function record() {
    const b = S.br;
    if (!b || b.F + b.L < 1) return;
    const pt = { x: +b.pst.toFixed(3), y: +(100 * b.F / (b.F + b.L)).toFixed(3), p: S.proj.ok ? +S.proj.pF.toFixed(3) : null, t: b.ht };
    const last = S.hist[S.hist.length - 1];
    if (last && last.x === pt.x) { S.hist[S.hist.length - 1] = pt; }
    else if (!last || pt.x > last.x) { S.hist.push(pt); }
    else if (pt.x < last.x - 1) { S.hist = [pt]; } // histórico de outra sessão/teste
    if (S.hist.length > 600) S.hist = S.hist.slice(-600);
    store.set(LS.hist, S.hist);
  }

  function diffItems(pb, b, pu, nu) {
    const items = [];
    const t = (b.ht || '').slice(0, 5);
    const sh = (o) => o.F + o.L ? 100 * o.F / (o.F + o.L) : null;
    const lp = sh(pb), ln = sh(b);
    if (lp != null && ln != null && (lp - 50) * (ln - 50) < 0) {
      items.push({ t, big: true, h: `<span class="big">Virada: ${ln > 50 ? '<span class="c-f">Flávio</span>' : '<span class="c-l">Lula</span>'} assume a liderança</span> com ${fP2(b.pst)} das seções.` });
    }
    if (!pb.eleito && b.eleito) {
      items.push({ t, big: true, h: `<span class="big">${b.eleito === CF ? 'Flávio Bolsonaro' : 'Lula'} está matematicamente eleito.</span>` });
    }
    const moves = [];
    for (const [uf, nome] of UFS) {
      const a = pu[uf], c = nu[uf];
      if (!a || !c || c.pst - a.pst < 0.1) continue;
      const s0 = sh(a), s1 = sh(c);
      const flip = s0 != null && s1 != null && (s0 - 50) * (s1 - 50) < 0;
      moves.push({ uf, nome, d: c.pst - a.pst, c, s0, s1, flip });
    }
    moves.sort((x, y) => (y.flip - x.flip) || (y.d * y.c.te - x.d * x.c.te));
    for (const m of moves.slice(0, 4)) {
      const lead = m.s1 >= 50 ? `<span class="c-f">Flávio ${fP1(m.s1)}</span>` : `<span class="c-l">Lula ${fP1(100 - m.s1)}</span>`;
      const dv = m.s0 != null ? ` (${fPP(m.s1 - m.s0).replace(' p.p.', '')} p/ Flávio)` : '';
      items.push({ t, h: `${m.flip ? '<b>Virou!</b> ' : ''}<b>${m.nome}</b> foi a ${fP1(m.c.pst)} apurado (+${nf1.format(m.d)}). ${lead}${dv}.` });
    }
    if (moves.length > 4) items.push({ t, h: `Mais ${moves.length - 4} UF${moves.length - 4 > 1 ? 's' : ''} atualizaram.` });
    return items.map((i) => ({ ...i, ht: b.ht }));
  }
  function diffFeed(pb, b, pu, nu) {
    const items = diffItems(pb, b, pu, nu);
    if (!items.length) return;
    S.feed = items.map((i) => ({ ...i, n: Date.now() })).concat(S.feed).slice(0, 80);
    store.set(LS.feed, S.feed);
  }

  // ---------- histórico gravado (branch data) ----------
  // O gravador (tools/recorder.py) publica um retrato completo por atualização do TSE.
  // Aqui cada retrato vira ponto do gráfico (com a projeção recalculada pelo mesmo modelo)
  // e os retratos consecutivos viram o feed. A leitura ao vivo completa o que vier depois.
  const HIST_URL = 'https://raw.githubusercontent.com/Sowsoc/apuracao-boletim/data/history.json';
  S.srv = { pts: [], chart: [], feed: [], lastHt: null };
  const unpack = (uf) => { const o = {}; for (const k in uf) { const [pst, te, est, F, L] = uf[k]; o[k] = { pst, te, est, F, L }; } return o; };
  function buildSrv() {
    const pts = S.srv.pts, chart = [], feed = [];
    let prev = null;
    for (const pt of pts) {
      const U = unpack(pt.uf), b = pt.br;
      if (b.F + b.L < 1) continue;
      const P = project(U, b);
      chart.push({ x: +b.pst.toFixed(3), y: 100 * b.F / (b.F + b.L), p: P.ok ? P.pF : null, t: b.ht });
      if (prev) feed.push(...diffItems(prev.b, b, prev.U, U));
      prev = { b, U };
    }
    S.srv.chart = chart;
    S.srv.feed = feed.reverse();
    S.srv.lastHt = pts.length ? pts[pts.length - 1].br.ht : null;
  }
  async function loadHist() {
    try {
      const r = await fetch(HIST_URL + '?m=' + Math.floor(Date.now() / 30000), { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d && Array.isArray(d.pts) && d.pts.length !== S.srv.pts.length) { S.srv.pts = d.pts; buildSrv(); renderChart(); renderFeed(); }
      }
    } catch (e) {}
    setTimeout(loadHist, 60000);
  }
  function chartPts() {
    const c = S.srv.chart;
    if (!c.length) return S.hist;
    const lx = c[c.length - 1].x;
    return c.concat(S.hist.filter((p) => p.x > lx));
  }
  function feedItems() {
    if (!S.srv.lastHt) return S.feed;
    return S.feed.filter((i) => i.ht && i.ht > S.srv.lastHt).concat(S.srv.feed).slice(0, 120);
  }

  // ---------- animação de números ----------
  const anim = new Map();
  function tween(el, to, fmt) {
    const from = anim.has(el) ? anim.get(el) : to;
    anim.set(el, to);
    if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 900;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1 && anim.get(el) === to) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- cores ----------
  const BINS = [2, 5, 10, 20];
  function tone(margin) { // margin = Flávio − Lula, em p.p.
    const a = Math.abs(margin);
    const i = BINS.findIndex((b) => a < b);
    const lvl = i === -1 ? 4 : i;
    const pct = [28, 45, 64, 82, 100][lvl];
    return `color-mix(in oklab, var(${margin >= 0 ? '--f' : '--l'}) ${pct}%, var(--paper))`;
  }
  function toneSw(sw) { // variação da fatia de Flávio em p.p.
    const a = Math.abs(sw);
    const pct = a < 1 ? 18 : a < 3 ? 40 : a < 6 ? 65 : 92;
    return `color-mix(in oklab, var(${sw >= 0 ? '--f' : '--l'}) ${pct}%, var(--paper))`;
  }
  const inkOn = (pctLevel) => pctLevel >= 64 ? 'var(--paper)' : 'var(--ink)';

  // ---------- render ----------
  function renderAll() {
    renderStamp(); renderLede(); renderRace(); renderFacts(); renderMap(); renderSim(); renderFeed(); renderChart(); renderTable();
  }

  function renderStamp() {
    const st = $('stampTx'), al = $('alert');
    if (S.err && !S.br) { st.innerHTML = '<span class="err">sem conexão com o TSE</span>'; }
    else if (S.br) {
      const tag = S.br.final ? 'FINAL' : 'AO VIVO';
      st.innerHTML = `<span class="live">${tag}</span>TSE às <b>${S.br.ht}</b>`;
    }
    if (S.err) { al.hidden = false; al.textContent = `A última leitura falhou (${S.err}). Tentando de novo em 10 s; os números abaixo são da leitura anterior.`; }
    else al.hidden = true;
  }

  function leader() {
    const b = S.br;
    if (!b || b.F + b.L < 1) return null;
    const pF = 100 * b.F / (b.F + b.L);
    return { pF, pL: 100 - pF, F: pF >= 50, diff: Math.abs(b.F - b.L), mg: 2 * pF - 100 };
  }

  function renderLede() {
    const b = S.br, ld = leader();
    if (!b || !ld) return;
    const who = ld.F ? 'Flávio' : 'Lula', other = ld.F ? 'Lula' : 'Flávio';
    const mg = Math.abs(ld.mg);
    let h;
    if (b.eleito) h = `${b.eleito === CF ? 'Flávio Bolsonaro' : 'Lula'} é eleito presidente`;
    else if (b.pst < 5) h = `${who} sai na frente, ${nf1.format(mg)} pontos à frente com as primeiras urnas`;
    else if (mg < 1) h = `Disputa voto a voto: ${who} tem vantagem mínima sobre ${other}`;
    else if (b.pst >= 90) h = `${who} se aproxima da vitória com ${fP1(b.pst)} das seções`;
    else h = `${who} lidera por ${nf1.format(mg)} pontos com ${nf0.format(Math.floor(b.pst))}% das urnas`;
    $('headline').textContent = h;
    let dek = `Com <b>${fP2(b.pst)}</b> das seções totalizadas, ${who} soma <b>${fP2(ld.F ? ld.pF : ld.pL)}</b> dos votos válidos, <b>${fMil(ld.diff)}</b> de votos a mais que ${other}.`;
    const P = S.proj;
    if (P && P.ok && !b.final) {
      const pw = P.pF >= 50 ? 'Flávio' : 'Lula';
      dek += ` A projeção do boletim aponta ${pw} com cerca de <b>${fP1(P.pF >= 50 ? P.pF : 100 - P.pF)}</b> ao fim da apuração.`;
    }
    $('dek').innerHTML = dek;
  }

  function renderRace() {
    const b = S.br, ld = leader();
    if (!b || !ld) return;
    tween($('pctF'), ld.pF, fP2); tween($('pctL'), ld.pL, fP2);
    tween($('votF'), b.F, (v) => fInt(v) + ' votos'); tween($('votL'), b.L, (v) => fInt(v) + ' votos');
    document.querySelector('.cand-f').classList.toggle('lead', ld.F);
    document.querySelector('.cand-l').classList.toggle('lead', !ld.F);
    // barra: largura proporcional ao eleitorado apurado (o resto fica neutro)
    $('barF').style.width = ld.pF + '%';
    $('barL').style.width = ld.pL + '%';
    const bp = $('barProj');
    if (S.proj && S.proj.ok && !b.final) { if (bp.hidden) { bp.style.transition = 'none'; bp.style.left = S.proj.pF + '%'; bp.hidden = false; void bp.offsetWidth; bp.style.transition = ''; } else bp.style.left = S.proj.pF + '%'; }
    else bp.hidden = true;
    const won = $('won');
    if (b.eleito) { won.hidden = false; won.innerHTML = `<span class="${b.eleito === CF ? 'c-f' : 'c-l'}">${b.eleito === CF ? 'Flávio Bolsonaro' : 'Lula'} eleito</span>`; }
    else won.hidden = true;
  }

  function renderFacts() {
    const b = S.br, ld = leader(), P = S.proj;
    if (!b || !ld) return;
    tween($('fSec'), b.pst, fP2);
    $('fSecBar').style.width = b.pst + '%';
    $('fSecS').textContent = `${fMil(b.est)} de ${fMil(b.te)} eleitores`;
    tween($('fDiff'), ld.diff, fMil);
    $('fDiffS').innerHTML = `${ld.F ? '<span class="c-f">Flávio</span>' : '<span class="c-l">Lula</span>'} à frente · ${nf1.format(Math.abs(ld.mg))} p.p.`;
    if (!P || !P.ok) { $('fRem').textContent = '—'; $('fNeed').textContent = '—'; return; }
    tween($('fRem'), P.REM, fMil);
    $('fRemS').textContent = `projeção: Flávio ${fP1(P.pF)} · Lula ${fP1(100 - P.pF)}`;
    const trail = ld.F ? 'Lula' : 'Flávio';
    $('fNeedK').textContent = `Para ${trail} virar`;
    const need = P.REM > 0 ? 100 * (ld.diff + P.REM) / (2 * P.REM) : Infinity;
    if (b.eleito || need > 100) {
      $('fNeed').textContent = need > 100 && isFinite(need) ? fP1(need) : '—';
      $('fNeedS').textContent = b.eleito ? 'Eleição decidida.' : `Precisaria de mais votos do que restam pela estimativa: virada praticamente impossível.`;
    } else {
      tween($('fNeed'), need, Math.abs(need - 50) < 1 ? fP2 : fP1);
      const now = ld.F ? ld.pL : ld.pF;
      $('fNeedS').textContent = `dos votos válidos que faltam. Hoje ${trail} faz ${fP1(now)}: ${need - now > 0 ? `precisa melhorar ${nf1.format(need - now)} pontos` : 'já faz o suficiente'} no restante.`;
    }
  }

  // ----- mapa -----
  const HX = (() => {
    const s = 37, w = Math.sqrt(3) * s, pad = 6;
    const pos = {};
    let mx = 0, my = 0;
    for (const [uf, nome, reg, r, c] of UFS) {
      const x = pad + w / 2 + w * (c + (r % 2) * 0.5);
      const y = pad + s + r * 1.5 * s;
      pos[uf] = { x, y, nome, reg };
      mx = Math.max(mx, x + w / 2); my = Math.max(my, y + s);
    }
    const pts = [];
    for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); pts.push([(s - 1) * Math.cos(a), (s - 1) * Math.sin(a)]); }
    return { s, w, pos, vb: `0 0 ${Math.ceil(mx + pad)} ${Math.ceil(my + pad)}`, path: 'M' + pts.map((p) => p.map((v) => v.toFixed(2)).join(',')).join('L') + 'Z' };
  })();

  function buildMap() {
    const svg = $('hexmap');
    svg.setAttribute('viewBox', HX.vb);
    let html = `<defs>`;
    for (const [uf] of UFS) { const p = HX.pos[uf]; html += `<clipPath id="cp-${uf}"><path d="${HX.path}" transform="translate(${p.x},${p.y})"/></clipPath>`; }
    html += `</defs>`;
    for (const [uf] of UFS) {
      const p = HX.pos[uf], s = HX.s;
      html += `<g class="hex" data-uf="${uf}" tabindex="0">
        <path class="h-bg" d="${HX.path}" transform="translate(${p.x},${p.y})"/>
        <rect class="h-fill" clip-path="url(#cp-${uf})" x="${p.x - s}" width="${2 * s}" y="${p.y + s}" height="0"/>
        <path class="h-out" d="${HX.path}" transform="translate(${p.x},${p.y})"/>
        <text class="h-uf" x="${p.x}" y="${p.y - 1}" text-anchor="middle">${uf === 'zz' ? 'EXT' : uf.toUpperCase()}</text>
        <text class="h-v" x="${p.x}" y="${p.y + 14}" text-anchor="middle"></text>
      </g>`;
    }
    svg.innerHTML = html;
    svg.querySelectorAll('.hex').forEach((g) => {
      const uf = g.dataset.uf;
      g.addEventListener('mouseenter', () => { S.sel = uf; renderCard(); });
      g.addEventListener('mouseleave', () => { S.sel = null; renderCard(); });
      g.addEventListener('click', (e) => { e.stopPropagation(); S.sel = S.sel === uf && g.classList.contains('sel') ? null : uf; renderCard(); });
      g.addEventListener('focus', () => { S.sel = uf; renderCard(); });
      g.addEventListener('blur', () => { S.sel = null; renderCard(); });
    });
    document.addEventListener('click', () => { if (S.sel) { S.sel = null; renderCard(); } });
  }

  function renderMap() {
    const svg = $('hexmap'), mode = S.mapMode;
    for (const [uf] of UFS) {
      const g = svg.querySelector(`[data-uf="${uf}"]`);
      const a = S.uf[uf], b = S.t1[uf], pr = S.proj && S.proj.per[uf];
      const fill = g.querySelector('.h-fill'), tv = g.querySelector('.h-v'), tu = g.querySelector('.h-uf');
      const p = HX.pos[uf], s = HX.s;
      let level = 0, color = 'var(--nd)', label = '', frac = 0;
      const sh = a && a.F + a.L > 0 ? 100 * a.F / (a.F + a.L) : null;
      if (mode === 'ap' && sh != null) {
        const mg = 2 * sh - 100; color = tone(mg); level = lvl(mg);
        frac = a.pst <= 0 ? 0 : 0.1 + 0.9 * a.pst / 100;
        label = (mg >= 0 ? 'F+' : 'L+') + nf0.format(Math.abs(mg));
      } else if (mode === 'pr' && pr && S.proj.ok) {
        const mg = 2 * pr.pF - 100; color = tone(mg); level = lvl(mg); frac = 1;
        label = (mg >= 0 ? 'F+' : 'L+') + nf0.format(Math.abs(mg));
      } else if (mode === 'v22' && sh != null && share22(uf) != null) {
        const sw = sh - 100 * share22(uf); color = toneSw(sw); frac = 1;
        level = Math.abs(sw) >= 3 ? 70 : 0;
        label = (sw >= 0 ? '+' : '−') + nf1.format(Math.abs(sw));
      } else if (mode === 'sw' && sh != null && b && b.F + b.L > 0) {
        const sw = sh - 100 * b.F / (b.F + b.L); color = toneSw(sw); frac = 1;
        level = Math.abs(sw) >= 3 ? 70 : 0;
        label = (sw >= 0 ? '+' : '−') + nf1.format(Math.abs(sw));
      }
      const fh = 2 * s * frac;
      fill.setAttribute('y', (p.y + s - fh).toFixed(1));
      fill.setAttribute('height', fh.toFixed(1));
      fill.style.fill = color;
      g.querySelector('.h-bg').style.fill = frac > 0 && frac < 1 ? `color-mix(in oklab, ${color} 22%, var(--nd))` : '';
      const onFill = frac > 0.55 ? inkOn(level) : 'var(--ink)';
      tu.style.fill = onFill; tv.style.fill = onFill;
      tv.textContent = label;
      if (S.prevUf && S.prevUf[uf] && a && a.pst > S.prevUf[uf].pst && renderMap.lastHt !== S.br.ht) {
        g.classList.remove('flash'); void g.getBBox(); g.classList.add('flash');
      }
    }
    if (S.br) renderMap.lastHt = S.br.ht;
    renderLegend();
    renderCard();
  }
  function lvl(mg) { const a = Math.abs(mg); const i = BINS.findIndex((b) => a < b); return [28, 45, 64, 82, 100][i === -1 ? 4 : i]; }

  function renderLegend() {
    const lg = $('legend');
    if (S.mapMode === 'sw' || S.mapMode === 'v22') {
      const st = [92, 65, 40, 18];
      lg.innerHTML = `<span>Flávio melhorou</span><span class="ramp">${st.map((p) => `<i style="background:color-mix(in oklab,var(--f) ${p}%,var(--paper))"></i>`).join('')}${st.slice().reverse().map((p) => `<i style="background:color-mix(in oklab,var(--l) ${p}%,var(--paper))"></i>`).join('')}</span><span>Lula melhorou</span><span>em relação ${S.mapMode === 'sw' ? 'ao 1º turno' : 'a 2022 (Bolsonaro)'} (faixas: 1, 3, 6 p.p.)</span>`;
    } else {
      const st = [100, 82, 64, 45, 28];
      lg.innerHTML = `<span class="c-f">Flávio</span><span class="ramp">${st.map((p) => `<i style="background:color-mix(in oklab,var(--f) ${p}%,var(--paper))"></i>`).join('')}${st.slice().reverse().map((p) => `<i style="background:color-mix(in oklab,var(--l) ${p}%,var(--paper))"></i>`).join('')}</span><span class="c-l">Lula</span><span>margem: &lt;2 · 2–5 · 5–10 · 10–20 · &gt;20 p.p.</span>`;
    }
  }

  function renderCard() {
    const card = $('ufCard'), svg = $('hexmap');
    svg.querySelectorAll('.hex').forEach((g) => g.classList.toggle('sel', g.dataset.uf === S.sel));
    const uf = S.sel, a = uf && S.uf[uf];
    if (!uf || !a) { card.hidden = true; return; }
    const b = S.t1[uf], pr = S.proj && S.proj.per[uf];
    const sh = a.F + a.L ? 100 * a.F / (a.F + a.L) : null;
    const s1 = b && b.F + b.L ? 100 * b.F / (b.F + b.L) : null;
    const row = (k, v) => `<div class="r"><span>${k}</span><span>${v}</span></div>`;
    card.innerHTML = `<h3>${HX.pos[uf].nome}</h3>` +
      row('Apurado', fP2(a.pst)) +
      row('<span class="c-f">Flávio</span>', sh == null ? '—' : `${fP2(sh)} · ${fMil(a.F)}`) +
      row('<span class="c-l">Lula</span>', sh == null ? '—' : `${fP2(100 - sh)} · ${fMil(a.L)}`) +
      row('Eleitorado', fMil(a.te)) +
      (s1 != null ? row('1º turno (F × L)', `${fP1(s1)} × ${fP1(100 - s1)}`) : '') +
      (sh != null && s1 != null ? row('Variação Flávio', fPP(sh - s1)) : '') +
      (share22(uf) != null ? row('2022 (Bolsonaro × Lula)', `${fP1(100 * share22(uf))} × ${fP1(100 - 100 * share22(uf))}`) : '') +
      (pr && S.proj.ok ? row('Projeção Flávio', fP1(pr.pF)) : '');
    card.hidden = false;
    const wrap = svg.parentElement.getBoundingClientRect(), r = svg.getBoundingClientRect();
    const k = r.width / svg.viewBox.baseVal.width, p = HX.pos[uf];
    let x = p.x * k + HX.w * k * 0.6, y = p.y * k - 40;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    if (x + cw > wrap.width) x = p.x * k - HX.w * k * 0.6 - cw;
    if (x < 0) x = 0;
    y = Math.max(0, Math.min(y, wrap.height - ch));
    card.style.transform = `translate(${x}px,${y}px)`;
  }

  // ----- simulador -----
  function renderSim() {
    const r = $('simR'), b = S.br, P = S.proj;
    if (!b || !P || !P.ok) { $('simOut').textContent = 'Disponível assim que houver votos suficientes para estimar o que falta.'; return; }
    if (!S.simTouched) { S.sim = Math.round(P.remShareF * 200) / 2; r.value = S.sim; }
    const x = +r.value / 100;
    r.style.setProperty('--p', ((+r.value - 20) / 60 * 100) + '%');
    $('simSplit').textContent = `${nf1.format(x * 100)}% · ${nf1.format(100 - x * 100)}% do que falta`;
    const F = b.F + P.REM * x, L = b.L + P.REM * (1 - x);
    const pF = 100 * F / (F + L);
    const w = pF >= 50 ? '<span class="c-f">Flávio vence</span>' : '<span class="c-l">Lula vence</span>';
    $('simOut').innerHTML = `Nesse cenário, ${w} por ${fMil(Math.abs(F - L))} de votos.<span class="res num"><span class="c-f">${fP2(pF)}</span> × <span class="c-l">${fP2(100 - pF)}</span></span>`;
  }
  $('simR').addEventListener('input', () => { S.simTouched = true; renderSim(); });
  $('simReset').addEventListener('click', () => { S.simTouched = false; renderSim(); });

  // ----- feed -----
  function renderFeed() {
    const f = $('feed');
    const items = feedItems();
    if (!items.length) return;
    const now = Date.now();
    f.innerHTML = items.map((i) => `<li class="${i.n && now - i.n < 4000 ? 'new' : ''}"><span class="t">${i.t}</span><span>${i.h}</span></li>`).join('');
  }

  // ----- gráfico -----
  function renderChart() {
    const svg = $('chart'), H = chartPts();
    const W = Math.max(320, Math.round(svg.clientWidth || 900)), Ht = 280;
    svg.setAttribute('viewBox', `0 0 ${W} ${Ht}`);
    const L = 44, R = 10, T = 12, B = 26;
    const pts = H.filter((p) => p.y != null);
    let lo = 45, hi = 55;
    for (const p of pts) { lo = Math.min(lo, p.y, p.p ?? p.y); hi = Math.max(hi, p.y, p.p ?? p.y); }
    const span = Math.max(Math.abs(lo - 50), Math.abs(hi - 50)) + 1;
    lo = 50 - span; hi = 50 + span;
    const X = (x) => L + (W - L - R) * x / 100;
    const Y = (y) => T + (Ht - T - B) * (hi - y) / (hi - lo);
    let g = `<rect class="zf" x="${L}" y="${T}" width="${W - L - R}" height="${Y(50) - T}"/><rect class="zl" x="${L}" y="${Y(50)}" width="${W - L - R}" height="${Ht - B - Y(50)}"/>`;
    for (let x = 0; x <= 100; x += 25) g += `<line class="ax" x1="${X(x)}" x2="${X(x)}" y1="${T}" y2="${Ht - B}"/><text x="${X(x)}" y="${Ht - 8}" text-anchor="middle">${x}%</text>`;
    const stepY = span > 8 ? 5 : span > 4 ? 2 : 1;
    for (let y = Math.ceil(lo / stepY) * stepY; y <= hi; y += stepY) if (y !== 50) g += `<line class="ax" x1="${L}" x2="${W - R}" y1="${Y(y)}" y2="${Y(y)}"/><text x="${L - 6}" y="${Y(y) + 4}" text-anchor="end">${y}</text>`;
    g += `<line class="mid" x1="${L}" x2="${W - R}" y1="${Y(50)}" y2="${Y(50)}"/><text x="${L - 6}" y="${Y(50) + 4}" text-anchor="end" style="fill:var(--ink)">50</text>`;
    g += `<text x="${L + 6}" y="${T + 14}" style="fill:var(--f)">Flávio à frente</text><text x="${L + 6}" y="${Ht - B - 6}" style="fill:var(--l)">Lula à frente</text>`;
    if (pts.length) {
      const ap = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
      g += `<path class="ap" d="${ap}"/>`;
      const pp = pts.filter((p) => p.p != null);
      if (pp.length) g += `<path class="pr" d="${pp.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.p).toFixed(1)}`).join('')}"/>`;
      const first = pts[0];
      if (first.x > 1 && first.t) g += `<line class="ax" x1="${X(first.x)}" x2="${X(first.x)}" y1="${T}" y2="${Ht - B}" style="stroke-dasharray:2 3"/><text x="${X(first.x) + 6}" y="${T + 14}">registro desde ${String(first.t).slice(0, 5)}</text>`;
      const last = pts[pts.length - 1];
      g += `<circle cx="${X(last.x)}" cy="${Y(last.y)}" r="4" style="fill:var(--ink)"/>`;
    } else {
      g += `<text x="${W / 2}" y="${Ht / 2}" text-anchor="middle">o gráfico começa na primeira leitura com votos</text>`;
    }
    svg.innerHTML = g;
  }

  // ----- tabela -----
  function rows() {
    const out = [];
    for (const [uf, nome, reg] of UFS) {
      const a = S.uf[uf]; if (!a) continue;
      const b = S.t1[uf], pr = S.proj && S.proj.ok && S.proj.per[uf];
      const sh = a.F + a.L ? 100 * a.F / (a.F + a.L) : null;
      const s1 = b && b.F + b.L ? 100 * b.F / (b.F + b.L) : null;
      out.push({ uf, nome, reg, te: a.te, pst: a.pst, pF: sh, pL: sh == null ? null : 100 - sh, mg: sh == null ? null : 2 * sh - 100, mg1: s1 == null ? null : 2 * s1 - 100, mg22: share22(uf) == null ? null : 200 * share22(uf) - 100, sw: sh != null && s1 != null ? sh - s1 : null, prF: pr ? pr.pF : null });
    }
    const { k, asc } = S.sort;
    out.sort((x, y) => {
      const a = x[k], b = y[k];
      if (a == null) return 1; if (b == null) return -1;
      const c = typeof a === 'string' ? a.localeCompare(b, 'pt') : a - b;
      return asc ? c : -c;
    });
    return out;
  }
  function renderTable() {
    const tb = document.querySelector('#tbl tbody');
    const v = (x, f) => x == null ? '<span style="color:var(--muted)">—</span>' : f(x);
    const mgf = (m) => `<span class="${m >= 0 ? 'c-f' : 'c-l'}">${m >= 0 ? 'F' : 'L'} +${nf1.format(Math.abs(m))}</span>`;
    let h = '';
    const b = S.br, P = S.proj;
    if (b && b.F + b.L) {
      const sh = 100 * b.F / (b.F + b.L);
      h += `<tr class="br"><td class="tl"><b>BR</b>Brasil</td><td>${fInt(b.te)}</td><td>${fP2(b.pst)}<span class="minibar"><i style="width:${b.pst}%"></i></span></td><td>${fP2(sh)}</td><td>${fP2(100 - sh)}</td><td>${mgf(2 * sh - 100)}</td><td></td><td></td><td>${P && P.ok ? fPP(P.swing * 100) : ''}</td><td>${P && P.ok ? fP1(P.pF) : '—'}</td></tr>`;
    }
    for (const r of rows()) {
      h += `<tr><td class="tl"><b>${r.uf === 'zz' ? 'EXT' : r.uf.toUpperCase()}</b>${r.nome}</td><td>${fInt(r.te)}</td><td>${fP1(r.pst)}<span class="minibar"><i style="width:${r.pst}%"></i></span></td><td>${v(r.pF, fP1)}</td><td>${v(r.pL, fP1)}</td><td>${v(r.mg, mgf)}</td><td>${v(r.mg1, mgf)}</td><td>${v(r.mg22, mgf)}</td><td>${v(r.sw, fPP)}</td><td>${v(r.prF, fP1)}</td></tr>`;
    }
    tb.innerHTML = h;
    document.querySelectorAll('#tbl th').forEach((th) => { th.classList.toggle('on', th.dataset.k === S.sort.k); th.classList.toggle('asc', th.dataset.k === S.sort.k && S.sort.asc); });
  }
  document.querySelectorAll('#tbl th').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    S.sort = { k, asc: S.sort.k === k ? !S.sort.asc : k === 'nome' };
    renderTable();
  }));

  // ----- modo do mapa -----
  $('mapMode').addEventListener('click', (e) => {
    const bt = e.target.closest('button'); if (!bt) return;
    S.mapMode = bt.dataset.m;
    $('mapMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === bt));
    $('mapNote').textContent = {
      ap: 'Cada hexágono enche de baixo para cima conforme as seções do estado são totalizadas. A cor indica quem lidera e por quanto.',
      pr: 'Resultado projetado de cada UF ao fim da apuração, pelo método descrito no fim da página.',
      sw: 'Quanto a fatia de Flávio (entre os dois) mudou em relação ao 1º turno, com o que já foi apurado.',
      v22: 'Fatia de Flávio hoje comparada à de Bolsonaro no 2º turno de 2022, estado a estado, com o que já foi apurado.',
    }[S.mapMode];
    renderMap();
  });

  // ----- barra de próxima leitura -----
  (function tick() {
    const left = Math.max(0, S.nextAt - Date.now());
    $('tickBar').style.width = S.nextAt ? (100 - 100 * left / POLL_MS) + '%' : '0';
    setTimeout(tick, 500);
  })();

  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() > S.nextAt - POLL_MS + 5000) poll(); });
  window.addEventListener('resize', () => { if (S.sel) renderCard(); clearTimeout(renderChart.t); renderChart.t = setTimeout(renderChart, 150); });

  // ---------- início ----------
  buildMap();
  renderFeed(); renderChart();
  loadT1().then((t1) => { S.t1 = t1; if (S.srv.pts.length) buildSrv(); if (S.br) { S.proj = project(); } renderAll(); });
  loadHist();
  poll();
})();
