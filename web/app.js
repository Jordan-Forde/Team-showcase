(() => {
  const $ = (id) => document.getElementById(id);
  const RAG = ["Red", "Amber", "Green", "Done"];
  const CLS = { Red: "red", Amber: "amber", Green: "green", Done: "done" };
  const COLOR = { Red: "var(--red)", Amber: "var(--amber)", Green: "var(--green)", Done: "var(--done)" };
  const MEANING = { Red: "Blocked or needs a decision", Amber: "In progress, needs follow-up", Green: "On track or live", Done: "Complete (moves to the Completed tab)" };
  const today = new Date().toISOString().slice(0, 10);
  const EMPTY_FILTERS = { q: "", pillar: "", owner: "", status: "", region: "", area: "", priority: false, thisWeek: false, overdue: false, attention: false, completed: false };
  const state = {
    data: null, history: [], view: "overview", msFilter: "all", canEdit: false, canJordan: false, auth: {}, editMode: false, exec: location.hash === "#exec",
    key: sessionStorage.getItem("editKey") || "",
    f: { ...EMPTY_FILTERS },
  };

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "value") n.value = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid);
    return n;
  }
  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const editorName = () => localStorage.getItem("editorName") || "";

  async function api(method, path, body) {
    const res = await fetch(path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { "Content-Type": "application/json", "X-Edit-Key": state.key, "X-Editor": encodeURIComponent(editorName()) },
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) { location.replace("/login"); throw new Error("Signed out"); }
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (res.status === 401) { location.replace("/login"); throw new Error("Signed out"); }
    return res.json();
  }

  // ---------- helpers ----------
  const pillars = () => state.data.pillars;
  const pillarOf = (id) => pillars().find((p) => p.id === id);
  const pillarLabel = (id) => { const p = pillarOf(id); return p ? `${p.id} ${p.name}` : "Cross-pillar"; };
  const fmtDate = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "TBC";
  const fmtShort = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const quarterOf = (iso) => `${iso.slice(0, 4)} Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;
  const isOverdue = (i) => i.due && i.due < today && (i.status === "Red" || i.status === "Amber");
  // Blocked, escalated or flagged as a priority.
  const needsAttention = (i) => i.status === "Red" || i.blocker || i.priority;
  const group = (list, fn) => list.reduce((m, x) => { const k = fn(x) || "Unspecified"; (m[k] = m[k] || []).push(x); return m; }, {});
  const rag = (list) => RAG.reduce((m, s) => ({ ...m, [s]: list.filter((i) => i.status === s).length }), {});
  const uniq = (list) => [...new Set(list.filter(Boolean))].sort();
  const owners = () => uniq([...state.data.items.map((i) => i.owner), ...pillars().map((p) => p.leader)]);
  const regionTokens = (r) => (r || "").split("/").map((s) => s.trim()).filter(Boolean);
  const filtering = () => Object.values(state.f).some(Boolean);
  const pillarText = (id) => { const p = pillarOf(id); return p ? `${p.id} ${p.name} ${p.leader}` : "cross-pillar"; };
  // Every whitespace-separated search term must appear somewhere in the record's text.
  const matches = (text) => state.f.q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => text.toLowerCase().includes(t));
  const dateText = (iso) => (iso ? `${iso} ${fmtDate(iso)}` : "");
  const itemText = (i) => [i.title, i.notes, i.area, i.owner, i.region, i.status, i.link, i.due && dateText(i.due), pillarText(i.pillar),
    i.priority && "priority", i.thisWeek && "this week", i.blocker && "blocker", isOverdue(i) && "overdue"].filter(Boolean).join(" ");
  const milestoneOk = (m) => (!state.f.pillar || m.pillar === state.f.pillar) && (!state.f.owner || m.owner === state.f.owner) &&
    matches([m.title, m.notes, m.owner, m.status, dateText(m.date), pillarText(m.pillar)].join(" "));
  const winOk = (w) => (!state.f.pillar || w.pillar === state.f.pillar) &&
    matches([w.title, w.detail, w.impact, w.unit, dateText(w.date), pillarText(w.pillar)].join(" "));
  const kpiOk = (k) => { const v = kpiView(k); return (!state.f.pillar || k.pillar === state.f.pillar) && matches([k.label, v.note, v.unit, v.value, v.target, pillarText(k.pillar)].join(" ")); };

  // Completed items stay out of the working views unless asked for; onlyDone feeds the Completed tab.
  function visible(onlyDone = false) {
    const { pillar, owner, status, region, area, priority, thisWeek, overdue, attention, completed } = state.f;
    return state.data.items.filter((i) =>
      (onlyDone ? i.status === "Done" : completed || i.status !== "Done" || status === "Done") &&
      (!pillar || i.pillar === pillar) && (!owner || i.owner === owner) && (onlyDone || !status || i.status === status) &&
      (!region || regionTokens(i.region).includes(region)) && (!area || i.area === area) && (!priority || i.priority) &&
      (!thisWeek || i.thisWeek) && (!overdue || isOverdue(i)) && (!attention || needsAttention(i)) && matches(itemText(i)));
  }

  // Jump to a page with the given filters added to whatever is already set.
  function drill(filters, view) {
    Object.assign(state.f, filters);
    syncFilters();
    setView(view);
  }

  // Compare against the snapshot closest to a week ago, falling back to the oldest earlier one.
  function baseline() {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const old = state.history.filter((h) => h.date <= cutoff.toISOString().slice(0, 10));
    return old.length ? old[old.length - 1] : state.history.find((h) => h.date < today) || null;
  }

  // ---------- charts ----------
  function stack(counts, onSeg) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    return el("div", { class: "stack" }, RAG.filter((s) => counts[s]).map((s) => {
      const seg = el("span", { class: CLS[s] + (onSeg ? " link" : ""), title: `${s}: ${counts[s]}${onSeg ? " – click to see them" : ""}` });
      seg.style.width = (counts[s] / total) * 100 + "%";
      if (onSeg) seg.addEventListener("click", (e) => { e.stopPropagation(); onSeg(s); });
      return seg;
    }));
  }

  // onPick(key) opens the list for a row; onSeg(key, status) opens it for one status segment.
  function breakdown(title, items, keyFn, labelFn = (k) => k, onPick, limit = 99, onSeg) {
    const all = Object.entries(group(items, keyFn)).sort((a, b) => b[1].length - a[1].length);
    const rest = all.slice(limit).flatMap(([, l]) => l);
    const groups = rest.length ? [...all.slice(0, limit), ["Other", rest]] : all;
    const max = groups.length ? Math.max(...groups.map(([, l]) => l.length)) : 1;
    const panel = el("div", { class: "panel" }, el("h3", {}, title));
    groups.forEach(([key, list]) => {
      const pick = onPick && key !== "Other";
      const bar = el("div", {}, stack(rag(list), pick && onSeg ? (s) => onSeg(key, s) : null));
      bar.style.width = (list.length / max) * 100 + "%";
      const row = el("div", { class: "row" + (pick ? " link" : "") },
        el("span", { class: "lbl", title: pick ? `${labelFn(key)} – click to open` : labelFn(key) }, labelFn(key)), bar, el("span", { class: "num" }, String(list.length)));
      if (pick) row.addEventListener("click", () => onPick(key));
      panel.append(row);
    });
    return panel;
  }

  function donut(counts, onPick) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    const s = svg("svg", { viewBox: "-2 -2 40 40", class: "donut", role: "img", "aria-label": "Status split" });
    let offset = 25;
    RAG.forEach((st) => {
      if (!counts[st]) return;
      const pct = (counts[st] / total) * 100;
      const arc = svg("circle", { cx: 18, cy: 18, r: 15.9155, fill: "none", stroke: COLOR[st], "stroke-width": 5, "stroke-dasharray": `${pct} ${100 - pct}`, "stroke-dashoffset": offset });
      if (onPick) { arc.setAttribute("class", "arc"); arc.addEventListener("click", () => onPick(st)); const tip = svg("title"); tip.textContent = `${st}: ${counts[st]} – click to see them`; arc.append(tip); }
      s.append(arc);
      offset -= pct;
    });
    const t = svg("text", { x: 18, y: 19.5, "text-anchor": "middle", "font-size": 7, "font-weight": 700, fill: "#1c2434" });
    t.textContent = String(total);
    s.append(t);
    const legend = el("div", { class: "legend" }, RAG.filter((st) => st !== "Done" || counts.Done).map((st) =>
      el("div", { class: onPick ? "link" : "", onclick: onPick ? () => onPick(st) : null }, el("i", { class: CLS[st] }), `${st}: ${counts[st]}`)));
    return el("div", { class: "panel" }, el("h3", {}, "Status split"), el("div", { class: "donutwrap" }, s, legend));
  }

  // rows: [{ label, title, segs: [{ cls, n, go? }] }]; a seg with go() is clickable.
  function stackedColumns(rows, empty) {
    if (!rows.length) return el("p", { class: "muted" }, empty);
    const sum = (r) => r.segs.reduce((a, s) => a + s.n, 0);
    const max = Math.max(1, ...rows.map(sum));
    return el("div", { class: "trend" }, rows.map((r) => {
      const bar = el("div", { class: "tbar", title: r.title }, r.segs.filter((s) => s.n).map((s) => {
        const seg = el("span", { class: s.cls + (s.go ? " link" : "") });
        seg.style.flex = `${s.n} 1 0`;
        if (s.go) seg.addEventListener("click", s.go);
        return seg;
      }));
      bar.style.height = (sum(r) / max) * 100 + "%";
      return el("div", { class: "tc" }, el("div", { class: "tn" }, String(sum(r))), el("div", { class: "plot" }, bar), el("small", {}, r.label));
    }));
  }

  function trendPanel() {
    const rows = state.history.slice(-12).map((s) => ({
      label: fmtShort(s.date), title: `${fmtDate(s.date)}: ${s.total} items`,
      segs: RAG.map((st) => ({ cls: CLS[st], n: s.status[st] })),
    }));
    return el("div", { class: "panel wide" }, el("h3", {}, "Status over time"),
      rows.length > 1 ? stackedColumns(rows) : el("p", { class: "muted" }, "Snapshots are saved automatically each day and after every change. The trend appears once there are two or more."));
  }

  function deliveredPanel() {
    const buckets = {};
    const add = (iso, key) => { if (!iso) return; const q = quarterOf(iso); (buckets[q] = buckets[q] || { item: 0, win: 0 })[key]++; };
    state.data.items.forEach((i) => add(i.completed, "item"));
    state.data.wins.forEach((w) => add(w.date, "win"));
    const rows = Object.keys(buckets).sort().map((q) => ({
      label: q, title: `${q}: ${buckets[q].item} items completed, ${buckets[q].win} wins`,
      segs: [{ cls: "c-item", n: buckets[q].item, go: () => setView("completed") }, { cls: "c-win", n: buckets[q].win, go: () => { setView("wins"); document.getElementById("wins-section")?.scrollIntoView(); } }],
    }));
    return el("div", { class: "panel" }, el("h3", {}, "Delivered by quarter"),
      stackedColumns(rows, "Mark items Done (or add win dates) to build this chart."),
      rows.length ? el("p", { class: "legend-line" }, el("span", {}, el("i", { class: "c-item" }), "Items completed"), el("span", {}, el("i", { class: "c-win" }), "Wins")) : null);
  }

  // ---------- lists ----------
  const tags = (i) => [
    i.priority && el("span", { class: "tag p" }, "Priority"),
    i.thisWeek && el("span", { class: "tag w" }, "This week"),
    i.milestone && el("span", { class: "tag m" }, "Milestone"),
    i.blocker && el("span", { class: "tag b" }, "Blocker"),
    i.internal && el("span", { class: "tag" }, "Internal"),
    isOverdue(i) && el("span", { class: "tag o" }, "Overdue"),
  ];

  function itemTable(items, showPillar) {
    return el("div", { class: "list" }, items.map((i) => {
      const meta = [[showPillar && i.pillar, "pillar"], [i.area, "area"], ...regionTokens(i.region).map((r) => [r, "region"])].filter(([v]) => v);
      const filterBy = (key, value) => (e) => { e.stopPropagation(); setFilter(key, value); };
      return el("div", { class: "it editable", tabindex: "0", role: "button", onclick: () => showItem(i), onkeydown: (e) => { if (e.key === "Enter") showItem(i); } },
        el("span", { class: "dot " + CLS[i.status], title: i.status, role: "img", "aria-label": i.status }),
        el("div", { class: "body" },
          el("div", { class: "t" }, el("strong", {}, i.title), " ", tags(i)),
          i.notes ? el("div", { class: "n" }, i.notes) : null,
          el("div", { class: "m" }, meta.map(([v, key]) => el("span", { class: "tag link", title: `Filter by ${v}`, onclick: filterBy(key, v) }, v)))),
        el("div", { class: "side" }, el("strong", { class: "link", title: `Filter by ${i.owner}`, onclick: filterBy("owner", i.owner) }, i.owner),
          el("span", {}, i.status === "Done" ? (i.completed ? `Completed ${fmtDate(i.completed)}` : "Completed") : i.due ? fmtDate(i.due) : "No due date")));
    }));
  }

  // Marks a card as click-to-edit; the hover/focus highlight and pencil badge come from CSS.
  function makeEditable(node, open) {
    if (state.exec) return node;
    node.classList.add("editable");
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.addEventListener("click", (e) => { if (!state.editMode) return; e.preventDefault(); e.stopPropagation(); open(); });
    node.addEventListener("keydown", (e) => { if (state.editMode && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); open(); } });
    return node;
  }

  async function patchItem(i, patch) {
    if (!(await ensureEdit())) return;
    try { const updated = await api("POST", "/api/items", { id: i.id, ...patch }); await refresh(); showItem(updated); } catch (err) { alert(err.message); }
  }

  // A value inside the item window that jumps to the related page.
  const linkTo = (text, filters, view) => el("button", { type: "button", class: "linkbtn", title: "Open", onclick: () => { dlg.close(); drill(filters, view); } }, text);

  async function clearWeek() {
    if (!(await ensureEdit())) return;
    const n = state.data.items.filter((i) => i.thisWeek).length;
    if (!n) { alert("No items are flagged as working on this week."); return; }
    if (!confirm(`Clear the "working on this week" flag on ${n} items?`)) return;
    try { await api("POST", "/api/clear-week", {}); await refresh(); } catch (err) { alert(err.message); }
  }

  // Manual milestones plus any item flagged as a milestone, in one shape.
  // A manual milestone linked to an item follows that item's status and date.
  const itemById = (id) => state.data.items.find((i) => i.id === id);
  const msStatusOf = (i) => (i.status === "Done" ? "Done" : i.status === "Red" ? "At risk" : "Upcoming");
  const msDateOf = (i) => (i.status === "Done" ? i.completed || i.due || "" : i.due || "");
  function allMilestones() {
    const manual = state.data.milestones.map((m) => {
      const i = m.itemId && itemById(m.itemId);
      return i ? { ...m, item: i, linked: true, status: msStatusOf(i), date: msDateOf(i) || m.date } : m;
    });
    const linkedIds = new Set(manual.filter((m) => m.linked).map((m) => m.itemId));
    const fromItems = state.data.items.filter((i) => i.milestone && !linkedIds.has(i.id)).map((i) => ({
      id: i.id, title: i.title, pillar: i.pillar, owner: i.owner, notes: i.notes, item: i, date: msDateOf(i), status: msStatusOf(i),
    }));
    return [...manual, ...fromItems];
  }

  function openMilestone(m) {
    if (m.linked && state.editMode) return openForm("milestones", state.data.milestones.find((x) => x.id === m.id));
    return m.item ? showItem(m.item) : state.editMode ? openForm("milestones", m) : setView("milestones");
  }

  const addBtn = (label, fn) => el("button", { class: "btn sm edit-only", onclick: fn }, label);

  // ---------- views ----------
  function summaryText(items) {
    const ms = allMilestones();
    return [`${new Set(items.map((i) => i.pillar)).size} pillars`, `${new Set(items.map((i) => i.owner)).size} owners`,
      `${state.data.wins.length} key wins`, `${ms.filter((m) => m.status === "Done").length} of ${ms.length} milestones achieved`].join(" · ");
  }

  // Headline numbers can be typed in, or calculated from the rest of the site so they never drift.
  const KPI_SOURCES = [["", "Enter manually"], ["areas", "Ownership areas in use (from items)"], ["headcount", "Team headcount (from owners)"], ["wins", "Key wins"], ["milestones", "Milestones achieved"]];
  const isLead = (name) => state.data.team.lead.toLowerCase().startsWith(String(name).toLowerCase());
  function kpiView(k) {
    const d = state.data;
    if (k.auto === "areas") {
      return { value: new Set(d.items.map((i) => `${i.pillar}|${i.area}`)).size, target: null, unit: "areas", note: `Across ${new Set(d.items.map((i) => i.pillar)).size} pillars`, live: true };
    }
    if (k.auto === "headcount") {
      const working = uniq(d.items.map((i) => i.owner)).filter((n) => !isLead(n));
      const everyone = uniq([...working, ...d.pillars.map((p) => p.leader).filter((n) => n && !isLead(n))]);
      const pending = everyone.filter((n) => !working.includes(n));
      return { value: working.length, target: everyone.length, unit: "people", note: pending.length ? `${pending.join(", ")} pending, no items yet` : "Everyone has work assigned", live: true };
    }
    if (k.auto === "wins") return { value: d.wins.length, target: null, unit: "wins", note: `Across ${new Set(d.wins.map((w) => w.pillar)).size} pillars`, live: true };
    if (k.auto === "milestones") {
      const ms = allMilestones();
      const risk = ms.filter((m) => msState(m) === "risk").length;
      return { value: ms.filter((m) => m.status === "Done").length, target: ms.length, unit: "achieved", note: risk ? `${risk} at risk or overdue` : "None at risk", live: true };
    }
    return { value: k.value, target: k.target, unit: k.unit, note: k.note, live: false };
  }

  function kpiCard(k) {
    const v = kpiView(k);
    const hasTarget = v.target != null && v.target > 0;
    const prog = hasTarget ? el("div", { class: "progress" }, el("div", { style: `width:${Math.min(100, ((v.value || 0) / v.target) * 100)}%` })) : null;
    return makeEditable(el("div", { class: "kpi" }, el("div", { class: "l" }, k.label, v.live ? el("span", { class: "tag live", title: "Calculated from the rest of the site" }, "Live") : null),
      el("div", { class: "n" }, String(v.value ?? "-"), hasTarget ? el("small", {}, ` / ${v.target}`) : null, " ", el("small", {}, v.unit || "")),
      prog, el("p", { class: "muted" }, v.note || "")), () => openForm("kpis", k));
  }

  function miniList(title, rows, empty) {
    return el("div", { class: "panel" }, el("h3", {}, title), rows.length ? el("div", { class: "mini" }, rows) : el("p", { class: "muted" }, empty));
  }

  const tileEl = (n, l, cls = "", note = null, tip = null, go = null) => el("div", { class: "kpi tile " + cls + (go ? " link" : ""), title: tip, tabindex: go ? "0" : null, role: go ? "button" : null,
    onclick: go, onkeydown: go ? (e) => { if (e.key === "Enter") go(); } : null }, el("div", { class: "n" }, String(n)), el("div", { class: "l" }, l), note);
  const statusLegend = () => el("p", { class: "legend-line" }, RAG.map((s) => el("span", {}, el("i", { class: CLS[s] }), el("b", {}, s), ` ${MEANING[s]}`)));

  // ---------- extra graphs for the overview and executive view ----------
  const monthShort = (ym) => new Date(ym + "-01T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

  function dueByMonthPanel(items) {
    const open = items.filter((i) => i.status !== "Done");
    const dated = open.filter((i) => i.due);
    const months = group(dated, (i) => i.due.slice(0, 7));
    const rows = Object.keys(months).sort().map((m) => ({
      label: monthShort(m), title: `${monthLabel(m)}: ${plural(months[m].length, "item")} due`,
      segs: RAG.filter((s) => s !== "Done").map((s) => ({ cls: CLS[s], n: months[m].filter((i) => i.status === s).length, go: state.exec ? null : () => drill({ status: s }, "items") })),
    }));
    const undated = open.length - dated.length;
    return el("div", { class: "panel" }, el("h3", {}, "Due by month"), stackedColumns(rows, "No due dates set yet."),
      undated ? el("p", { class: "muted" }, `${plural(undated, "open item")} without a due date`) : null);
  }

  function winsByPillarPanel() {
    const wins = state.data.wins.filter(winOk);
    const rows = [...pillars().map((p) => [pillarLabel(p.id), p.id, wins.filter((w) => w.pillar === p.id).length]), ["Cross-pillar", "", wins.filter((w) => !w.pillar).length]].filter(([, , n]) => n);
    const max = Math.max(1, ...rows.map(([, , n]) => n));
    return el("div", { class: "panel" }, el("h3", {}, "Key wins by pillar"), rows.length ? rows.map(([label, id, n]) => {
      const bar = el("div", {}, stack({ Green: n }));
      bar.style.width = (n / max) * 100 + "%";
      return el("div", { class: "row" }, el("span", { class: "lbl", title: label }, label), bar, el("span", { class: "num" }, String(n)));
    }) : el("p", { class: "muted" }, "No wins recorded yet."));
  }

  // Owners down the side, pillars across the top; darker cells hold more items.
  function workloadPanel(items) {
    const ps = pillars().filter((p) => items.some((i) => i.pillar === p.id));
    // The team lead's own items count as Unassigned; pillar leaders with no items still get a row.
    const who = (i) => (!i.owner || isLead(i.owner) ? "~" : i.owner);
    const leaders = pillars().map((p) => p.leader).filter((n) => n && !isLead(n));
    const owners = uniq([...items.map(who), ...leaders]).sort((a, b) => items.filter((i) => who(i) === b).length - items.filter((i) => who(i) === a).length);
    const count = (o, p) => items.filter((i) => who(i) === o && i.pillar === p).length;
    const max = Math.max(1, ...owners.flatMap((o) => ps.map((p) => count(o, p.id))));
    const grid = el("div", { class: "heat", style: `grid-template-columns: minmax(90px, 1.2fr) repeat(${ps.length}, minmax(0, 1fr)) 56px` },
      el("span"), ps.map((p) => el("span", { class: "hh", title: p.name }, p.id, el("small", {}, p.name.split(/[ ,&]/)[0]))), el("span", { class: "hh" }, "Total"),
      owners.flatMap((o) => [el("span", { class: "hl" }, o === "~" ? "Unassigned" : o),
        ...ps.map((p) => {
          const n = count(o, p.id);
          const cell = el("span", { class: "hc" + (n ? " has" : "") + (n && !state.exec ? " link" : ""), title: n ? `${o === "~" ? "Unassigned" : o} · ${p.id}: ${plural(n, "item")}` : null,
            onclick: n && !state.exec ? () => drill({ owner: o === "~" ? "" : o, pillar: p.id }, "items") : null }, n ? String(n) : "·");
          if (n) { const a = 0.12 + 0.8 * (n / max); cell.style.background = `rgba(47, 91, 234, ${a})`; cell.style.color = a > 0.5 ? "#fff" : "var(--ink)"; }
          return cell;
        }),
        el("span", { class: "ht" }, String(items.filter((i) => who(i) === o).length))]));
    return el("div", { class: "panel wide" }, el("h3", {}, "Who is working where"), grid);
  }

  function renderOverview(items) {
    const r = rag(items);
    const base = filtering() ? null : baseline();
    const tile = (n, l, cls, prev, tip, go) => {
      const d = base && prev != null ? n - prev : 0;
      return tileEl(n, l, cls, d ? el("div", { class: "delta" }, `${d > 0 ? "▲" : "▼"} ${Math.abs(d)} since ${fmtShort(base.date)}`) : null, tip ? `${tip} – click to see them` : null, go);
    };
    const kpis = state.data.kpis.filter(kpiOk);
    const next = allMilestones().filter((m) => m.status !== "Done" && milestoneOk(m))
      .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999")).slice(0, 5).map((m) =>
        el("div", { class: "mi link", tabindex: "0", role: "button", onclick: () => openMilestone(m), onkeydown: (e) => { if (e.key === "Enter") openMilestone(m); } },
          el("span", { class: "when" }, fmtDate(m.date)), el("div", {}, el("strong", {}, m.title), el("div", { class: "muted" }, m.owner))));
    return el("div", { class: "overview" },
      el("p", { class: "lead-text" }, summaryText(items)),
      el("div", { class: "kpis tiles" },
        tile(items.length, "Active items", "", base && base.total - base.status.Done, "Everything not marked Done", () => drill({}, "items")),
        tile(r.Amber, "In progress", "t-amber", base?.status.Amber, MEANING.Amber, () => drill({ status: "Amber" }, "items")),
        tile(r.Green, "On track", "t-green", base?.status.Green, MEANING.Green, () => drill({ status: "Green" }, "items")),
        tile(r.Red, "Blocked", "t-red", base?.status.Red, MEANING.Red, () => drill({ status: "Red" }, "items")),
        tile(items.filter(isOverdue).length, "Overdue", "t-red", base?.overdue, "Past the due date and still Red or Amber", () => drill({ overdue: true }, "items")),
        tile(items.filter((i) => i.thisWeek).length, "Working this week", "t-week", null, "Flagged as being worked on this week", () => drill({ thisWeek: true }, "items")),
        tile(items.filter((i) => i.priority).length, "Priorities", "", base?.priorities, "Flagged as a priority", () => drill({ priority: true }, "items")),
        tile(visible(true).length, "Completed", "t-done", base?.status.Done, "Items marked Done move to the Completed list on the Items page", () => setView("completed"))),
      el("h3", { class: "group-title" }, "Headline numbers", addBtn("+ Add KPI", () => openForm("kpis", {}))),
      el("div", { class: "kpis" }, kpis.map(kpiCard)),
      el("h3", { class: "group-title" }, "Breakdown"),
      el("div", { class: "dash" },
        donut(r, (s) => drill({ status: s }, "items")),
        breakdown("By pillar", items, (i) => i.pillar, (k) => pillarLabel(k), (k) => drill({ pillar: k }, "pillars"), 99, (k, s) => drill({ pillar: k, status: s }, "items")),
        breakdown("By owner", items, (i) => i.owner, undefined, (k) => drill({ owner: k }, "owners"), 99, (k, s) => drill({ owner: k, status: s }, "items")),
        workloadPanel(items),
        breakdown("By area", items, (i) => i.area, undefined, (k) => drill({ area: k }, "items"), 12, (k, s) => drill({ area: k, status: s }, "items")),
        dueByMonthPanel(items), winsByPillarPanel(),
        miniList("Next milestones", next, "No upcoming milestones."),
        breakdown("By region", items.flatMap((i) => (regionTokens(i.region).length ? regionTokens(i.region) : [""]).map((x) => ({ ...i, region: x }))), (i) => i.region, undefined, (k) => drill({ region: k }, "items"), 7, (k, s) => drill({ region: k, status: s }, "items")),
        deliveredPanel(), trendPanel()));
  }

  const openPillars = new Set(JSON.parse(localStorage.getItem("openPillars") || "[]"));
  const savePillars = () => localStorage.setItem("openPillars", JSON.stringify([...openPillars]));
  const closedAreas = new Set(JSON.parse(localStorage.getItem("closedAreas") || "[]"));
  const saveAreas = () => localStorage.setItem("closedAreas", JSON.stringify([...closedAreas]));
  const areaKey = (pillarId, area) => `${pillarId}|${area}`;

  function renderPillars(items) {
    const shown = pillars().filter((p) => (!state.f.pillar || p.id === state.f.pillar) && (!filtering() || items.some((i) => i.pillar === p.id)));
    const setAll = (open) => () => {
      shown.forEach((p) => {
        open ? openPillars.add(p.id) : openPillars.delete(p.id);
        uniq(state.data.items.filter((i) => i.pillar === p.id).map((i) => i.area)).forEach((a) => (open ? closedAreas.delete(areaKey(p.id, a)) : closedAreas.add(areaKey(p.id, a))));
      });
      savePillars(); saveAreas(); render();
    };
    return el("div", {},
      el("div", { class: "items-top" },
        el("div", { class: "items-actions" }, el("button", { class: "btn ghost sm", onclick: setAll(true) }, "Expand all"), el("button", { class: "btn ghost sm", onclick: setAll(false) }, "Collapse all")),
        el("div", { class: "items-actions" }, addBtn("+ Add item", () => openForm("items", { pillar: state.f.pillar || "" })))),
      shown.map((p) => {
        const list = items.filter((i) => i.pillar === p.id);
        const areas = Object.entries(group(list, (i) => i.area)).sort((a, b) => a[0].localeCompare(b[0]));
        const r = rag(list);
        const completedN = state.data.items.filter((i) => i.pillar === p.id && i.status === "Done").length;
        const det = el("details", { class: "pillar", open: openPillars.has(p.id) || !!state.f.q },
          el("summary", {},
            el("div", { class: "ph" },
              el("div", {}, el("h2", {}, `${p.id} — ${p.name}`), el("p", { class: "muted" }, p.focus)),
              makeEditable(el("div", { class: "lead" }, el("span", { class: "muted" }, "Pillar leader"), el("span", { class: "leader link", title: p.leader ? `See ${p.leader} in the Team tab` : null,
                onclick: (e) => { if (state.editMode || !p.leader) return; e.preventDefault(); e.stopPropagation(); drill({ owner: p.leader }, "owners"); } }, p.leader || "Unassigned")), () => openForm("pillars", p))),
            el("div", { class: "row", style: "grid-template-columns:1fr 260px" }, stack(r),
              el("span", { class: "muted" }, `${list.length} active · ${r.Red} red · ${r.Amber} amber · ${r.Green} green · ${completedN} completed`))),
          el("div", { class: "pbody" },
            areas.map(([area, rows]) => {
              const key = areaKey(p.id, area);
              const box = el("details", { class: "areabox", open: !closedAreas.has(key) || !!state.f.q },
                el("summary", { class: "area" }, `${area} (${rows.length})`), itemTable(rows, false));
              box.addEventListener("toggle", () => {
                if (state.f.q) return;
                box.open ? closedAreas.delete(key) : closedAreas.add(key);
                saveAreas();
              });
              return box;
            }),
            list.length ? null : el("div", { class: "empty" }, "No items for this pillar with the current filters.")));
        det.addEventListener("toggle", () => {
          if (state.f.q) return;
          det.open ? openPillars.add(p.id) : openPillars.delete(p.id);
          savePillars();
        });
        return det;
      }));
  }

  function leadersTable(items) {
    return el("table", {}, el("thead", {}, el("tr", {}, ["Pillar", "Leader", "Active", "On track", "Amber", "Red", "Completed"].map((h) => el("th", {}, h)))),
      el("tbody", {}, pillars().map((p) => {
        const r = rag(items.filter((i) => i.pillar === p.id));
        const completedN = state.data.items.filter((i) => i.pillar === p.id && i.status === "Done").length;
        return el("tr", {}, el("td", {}, `${p.id} ${p.name}`), el("td", {}, p.leader || "Unassigned"), el("td", {}, String(r.Red + r.Amber + r.Green + r.Done)),
          el("td", {}, String(r.Green)), el("td", {}, String(r.Amber)), el("td", {}, String(r.Red)), el("td", {}, String(completedN)));
      })));
  }

  const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const openLists = new Set();

  function renderOwners(items) {
    const lead = (state.data.team.lead || "").toLowerCase();
    const isLead = (n) => n.toLowerCase() === lead || n.toLowerCase() === lead.split(" ")[0];
    const mine = (name) => items.filter((i) => i.owner === name);
    const people = uniq([...pillars().map((p) => p.leader), ...state.data.items.map((i) => i.owner)])
      .filter((n) => !isLead(n) && (!state.f.owner || n === state.f.owner))
      .sort((a, b) => mine(b).length - mine(a).length || a.localeCompare(b));
    const hiddenLead = items.filter((i) => isLead(i.owner)).length;

    const card = (name) => {
      const list = mine(name);
      const r = rag(list);
      const led = pillars().filter((p) => p.leader === name);
      const areas = Object.entries(group(list, (i) => i.area)).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
      const attention = [...list.filter((i) => i.status === "Red" || i.blocker), ...list.filter((i) => needsAttention(i) && i.status !== "Red" && !i.blocker)];
      const stat = (n, l, cls = "", go = null) => el("div", { class: "own-stat " + cls + (go ? " link" : ""), onclick: go, title: go ? "Click to see them" : null }, el("div", { class: "n" }, String(n)), el("div", { class: "l" }, l));
      const doneN = state.data.items.filter((i) => i.owner === name && i.status === "Done").length;
      const focus = list.filter((i) => i.thisWeek);
      const ownRow = (i) => el("div", { class: "mi", tabindex: "0", role: "button", onclick: () => showItem(i), onkeydown: (e) => { if (e.key === "Enter") showItem(i); } },
        el("span", { class: "dot " + CLS[i.status] }), el("strong", {}, i.title));
      const section = (label, rows, empty, viewAll, limit = 5) => {
        const key = `${name}|${label}`;
        const open = openLists.has(key);
        return el("div", { class: "own-attn" },
          el("div", { class: "own-sec-head" }, el("div", { class: "x-label" }, `${label} (${rows.length})`),
            rows.length ? el("button", { type: "button", class: "btn ghost sm", onclick: viewAll }, "View in Items →") : null),
          rows.length ? [(open ? rows : rows.slice(0, limit)).map(ownRow),
            rows.length > limit ? el("button", { type: "button", class: "linkbtn more", onclick: () => { open ? openLists.delete(key) : openLists.add(key); render(); } }, open ? "Show less" : `Show ${rows.length - limit} more`) : null]
            : el("p", { class: "muted" }, empty));
      };
      return el("div", { class: "own-card" },
        el("div", { class: "own-head" }, el("div", { class: "avatar" }, initials(name)),
          el("div", {}, el("h4", {}, name), el("p", { class: "muted" }, led.length ? `Leads ${led.map((p) => `${p.id} ${p.name}`).join(", ")}` : "Team member")),
          el("button", { class: "btn ghost sm own-all", onclick: () => drill({ owner: name }, "items") }, "View all items →")),
        list.length ? [
          el("div", { class: "own-stats" }, stat(list.length, "Active", "", () => drill({ owner: name }, "items")), stat(r.Red, "Blocked", r.Red ? "bad" : "", () => drill({ owner: name, status: "Red" }, "items")),
            stat(list.filter((i) => i.thisWeek).length, "This week", "", () => drill({ owner: name, thisWeek: true }, "items")), stat(list.filter((i) => i.priority).length, "Priorities", "", () => drill({ owner: name, priority: true }, "items"))),
          stack(r),
          el("div", { class: "own-row" }, pillars().map((p) => ({ p, n: list.filter((i) => i.pillar === p.id).length })).filter((x) => x.n).map((x) =>
            el("span", { class: "tag link", title: `${x.p.name} – click to see them`, onclick: () => drill({ owner: name, pillar: x.p.id }, "items") }, `${x.p.id} · ${x.n}`))),
          areas.length ? el("div", { class: "own-row" }, el("span", { class: "muted" }, "Main areas:"), areas.map(([a, l]) =>
            el("span", { class: "tag link", title: "Click to see them", onclick: () => drill({ owner: name, area: a }, "items") }, `${a} (${l.length})`))) : null,
          section("Working on this week", focus, "Nothing flagged for this week.", () => drill({ owner: name, thisWeek: true }, "items")),
          section("Needs attention", attention, "Nothing needs attention.", () => drill({ owner: name, attention: true }, "items")),
        ] : el("p", { class: "own-empty" }, "No active items assigned yet."),
        el("div", { class: "own-foot" }, el("span", { class: "muted" }, `${doneN} completed`),
          doneN ? el("button", { class: "btn ghost sm", onclick: () => drill({ owner: name }, "completed") }, "View completed →") : null));
    };

    const counts = (n) => pillars().map((p) => mine(n).filter((i) => i.pillar === p.id).length);
    const max = Math.max(1, ...people.flatMap(counts));
    const matrix = el("table", { class: "matrix" },
      el("thead", {}, el("tr", {}, el("th", {}, "Person"), pillars().map((p) => el("th", { class: "c link", title: `${p.name} – open pillar`, onclick: () => drill({ pillar: p.id }, "pillars") }, p.id)), el("th", { class: "c" }, "Total"))),
      el("tbody", {}, people.map((n) => el("tr", {}, el("td", { class: "link", title: "See their items", onclick: () => drill({ owner: n }, "items") }, n),
        counts(n).map((c, idx) => {
          const td = el("td", { class: "c" + (c ? " link" : ""), onclick: c ? () => drill({ owner: n, pillar: pillars()[idx].id }, "items") : null }, c ? String(c) : "–");
          if (c) td.style.background = `rgba(47, 91, 234, ${(0.08 + (0.35 * c) / max).toFixed(2)})`;
          if (pillars()[idx].leader === n) td.append(" ★");
          return td;
        }), el("td", { class: "c link", onclick: () => drill({ owner: n }, "items") }, el("strong", {}, String(mine(n).length)))))));
    return el("div", {},
      el("div", { class: "own-grid" }, people.length ? people.map(card) : el("div", { class: "empty" }, "No team members match the current filters.")),
      people.length ? [el("h3", { class: "group-title" }, "Workload by pillar", el("small", {}, "★ pillar leader · active items")), matrix] : null,
      hiddenLead ? el("p", { class: "muted", style: "margin-top:12px" }, `${hiddenLead} active items owned by ${state.data.team.lead} are not shown on this page.`) : null);
  }

  const dayDiff = (iso) => Math.round((new Date(iso + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const msState = (m) => (m.status === "Done" ? "done" : m.status === "At risk" || (m.date && m.date < today) ? "risk" : "upcoming");
  const msWhen = (m) => {
    if (m.status === "Done") return "Achieved";
    if (!m.date) return "No date set";
    const d = dayDiff(m.date);
    return d === 0 ? "Due today" : d > 0 ? `In ${plural(d, "day")}` : `${plural(-d, "day")} overdue`;
  };

  function renderMilestones(items) {
    const all = allMilestones().filter(milestoneOk);
    const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999");
    const counts = { done: 0, upcoming: 0, risk: 0 };
    all.forEach((m) => counts[msState(m)]++);
    const pct = all.length ? Math.round((counts.done / all.length) * 100) : 0;
    const nextUp = all.filter((m) => msState(m) === "upcoming" && m.date).sort(byDate)[0];
    const pick = (key) => () => { state.msFilter = state.msFilter === key ? "all" : key; render(); };
    const shown = all.filter((m) => state.msFilter === "all" || msState(m) === state.msFilter).sort(byDate);

    const tile = (key, n, label, cls, extra) => el("div", { class: `ms-tile ${cls}${state.msFilter === key ? " on" : ""}`, tabindex: "0", role: "button", title: "Click to filter",
      onclick: pick(key), onkeydown: (e) => { if (e.key === "Enter") pick(key)(); } },
      el("div", { class: "n" }, String(n)), el("div", { class: "l" }, label), extra);
    const tiles = el("div", { class: "ms-tiles" },
      tile("done", counts.done, "Achieved", "ms-done", el("div", { class: "progress" }, el("div", { style: `width:${pct}%` }))),
      tile("upcoming", counts.upcoming, "Upcoming", "ms-up"),
      tile("risk", counts.risk, "At risk or overdue", "ms-risk"),
      el("div", { class: "ms-tile ms-next" + (nextUp ? " link" : ""), onclick: nextUp ? () => openMilestone(nextUp) : null },
        el("div", { class: "l" }, "Next milestone"),
        nextUp ? [el("div", { class: "ms-next-title" }, nextUp.title), el("div", { class: "muted" }, `${fmtDate(nextUp.date)} · ${msWhen(nextUp)}`)] : el("div", { class: "muted" }, "Nothing scheduled")));

    const cols = {};
    shown.forEach((m) => (cols[m.date ? quarterOf(m.date) : "No date"] = cols[m.date ? quarterOf(m.date) : "No date"] || []).push(m));
    const order = Object.keys(cols).sort((a, b) => (a === "No date") - (b === "No date") || a.localeCompare(b));
    const thisQuarter = quarterOf(today);
    const card = (m) => {
      const st = msState(m);
      return makeEditable(el("div", { class: "rm-card " + st, onclick: () => { if (!state.editMode && m.item) showItem(m.item); } },
        el("div", { class: "rm-top" }, el("span", { class: "rm-date" }, m.date ? fmtDate(m.date) : "No date"), el("span", { class: "rm-pill " + st }, st === "done" ? "✓ Achieved" : msWhen(m))),
        el("h4", {}, m.title),
        m.notes ? el("p", { class: "rm-notes" }, m.notes) : null,
        el("div", { class: "rm-meta" }, m.owner ? el("span", { class: "rm-owner" }, el("i", { class: "mini-avatar" }, initials(m.owner)), m.owner) : null,
          m.pillar ? el("span", { class: "tag", title: pillarLabel(m.pillar) }, m.pillar) : null, m.item ? el("span", { class: "tag m" }, m.linked ? "Linked item" : "From item") : null)),
        () => openMilestone(m));
    };
    const roadmap = shown.length ? el("div", { class: "roadmap" }, order.map((q) => el("section", { class: "rm-col" + (q === thisQuarter ? " now" : "") },
      el("header", {}, el("strong", {}, q), q === thisQuarter ? el("span", { class: "rm-now" }, "This quarter") : null, el("small", {}, plural(cols[q].length, "milestone"))),
      cols[q].map(card))))
      : el("div", { class: "empty" }, all.length ? "No milestones match this filter." : "No milestones yet. In edit mode, use + Add milestone, or mark an item as a milestone.");

    const soon = new Date(); soon.setDate(soon.getDate() + 60);
    const deadlines = items.filter((i) => i.due && i.status !== "Done" && i.due >= today && i.due <= soon.toISOString().slice(0, 10)).sort((a, b) => a.due.localeCompare(b.due));
    const deadlineRows = deadlines.map((i) => el("div", { class: "dl-row link", tabindex: "0", role: "button", onclick: () => showItem(i), onkeydown: (e) => { if (e.key === "Enter") showItem(i); } },
      el("span", { class: "dl-date" }, fmtDate(i.due)), el("span", { class: "dot " + CLS[i.status] }), el("strong", {}, i.title),
      el("span", { class: "muted" }, `${i.owner} · ${i.pillar}`), el("span", { class: "muted dl-when" }, plural(dayDiff(i.due), "day"))));

    return el("div", {},
      el("h3", { class: "group-title" }, "Milestones", el("small", {}, state.msFilter === "all" ? `${all.length} total` : `${shown.length} of ${all.length} shown`),
        state.msFilter !== "all" ? el("button", { class: "btn sm ghost", onclick: pick(state.msFilter) }, "Show all") : null, addBtn("+ Add milestone", () => openForm("milestones", {}))),
      tiles, roadmap, renderWins(),
      el("h3", { class: "group-title" }, "Item deadlines", el("small", {}, `next 60 days · ${deadlines.length} items`)),
      deadlines.length ? el("div", { class: "dl-list" }, deadlineRows) : el("div", { class: "empty" }, "Nothing is due in the next 60 days."));
  }

  function renderWins() {
    const wins = state.data.wins.filter(winOk);
    const groups = Object.entries(group(wins, (w) => w.unit)).sort();
    return el("div", { id: "wins-section" },
      el("h3", { class: "group-title" }, "Key wins", el("small", {}, `${wins.length} wins`), addBtn("+ Add win", () => openForm("wins", {}))),
      wins.length ? null : el("div", { class: "empty" }, "No wins yet."),
      groups.map(([unit, list]) => [
        el("h3", { class: "group-title" }, unit, el("small", {}, `${list.length}`)),
        el("div", { class: "cards" }, list.map((w) => makeEditable(el("div", { class: "card" },
          el("span", { class: "tag link", title: "Show wins for this pillar", onclick: (e) => { if (state.exec || !w.pillar) return; e.stopPropagation(); setFilter("pillar", w.pillar); } }, pillarLabel(w.pillar)), el("h4", {}, w.title), el("p", {}, w.detail),
          w.impact ? el("p", { class: "impact" }, w.impact) : null,
          el("p", { class: "muted" }, w.date ? fmtDate(w.date) : state.exec ? "" : el("span", { class: "tag warn" }, "Date TBC"))), () => openForm("wins", w))))]));
  }

  // ---- Items page: sortable columns, optional grouping, quick filters ----
  const itemSorts = { items: { key: "status", dir: 1 }, completed: { key: "completed", dir: 1 } };
  const itemsGroups = { items: localStorage.getItem("itemsGroup") || "none", completed: localStorage.getItem("completedGroup") || "completed" };
  const closedGroups = new Set();
  const alpha = (a, b) => a.localeCompare(b);
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const byDue = (a, b) => (a.due || "9999").localeCompare(b.due || "9999");
  const ITEM_SORTS = {
    status: (a, b) => RAG.indexOf(a.status) - RAG.indexOf(b.status) || byDue(a, b) || byTitle(a, b),
    title: byTitle,
    pillar: (a, b) => a.pillar.localeCompare(b.pillar) || byTitle(a, b),
    owner: (a, b) => a.owner.localeCompare(b.owner) || byTitle(a, b),
    area: (a, b) => a.area.localeCompare(b.area) || byTitle(a, b),
    region: (a, b) => (a.region || "~").localeCompare(b.region || "~") || byTitle(a, b),
    due: (a, b) => byDue(a, b) || byTitle(a, b),
    completed: (a, b) => (b.completed || "").localeCompare(a.completed || "") || byTitle(a, b),
  };
  const monthLabel = (ym) => new Date(ym + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const GROUPS = {
    completed: { key: (i) => (i.completed ? quarterOf(i.completed) : "~"), label: (k) => (k === "~" ? "No completed date" : k), order: (a, b) => (a === "~") - (b === "~") || b.localeCompare(a) },
    pillar: { key: (i) => i.pillar || "~", label: (k) => (k === "~" ? "Cross-pillar" : pillarLabel(k)), order: alpha },
    owner: { key: (i) => i.owner || "~", label: (k) => (k === "~" ? "Unassigned" : k), order: alpha },
    status: { key: (i) => i.status, label: (k) => `${k} · ${MEANING[k]}`, order: (a, b) => RAG.indexOf(a) - RAG.indexOf(b) },
    area: { key: (i) => i.area || "~", label: (k) => (k === "~" ? "No area" : k), order: alpha },
    due: { key: (i) => (!i.due ? "~" : isOverdue(i) ? "!" : i.due.slice(0, 7)), label: (k) => (k === "~" ? "No due date" : k === "!" ? "Overdue" : monthLabel(k)), order: alpha },
  };

  // scope "items" is the working list (Active or All); "completed" is the Done archive.
  function renderItems(items, scope = "items") {
    const f = state.f;
    const itemSort = itemSorts[scope];
    const itemsGroup = itemsGroups[scope];
    const done = scope === "completed";
    // Quick-filter counts ignore the quick filters themselves so each pill shows what it would give.
    const keep = state.f;
    state.f = { ...keep, status: "", thisWeek: false, priority: false, overdue: false, attention: false };
    const base = visible();
    state.f = keep;
    const quickOff = { status: "", thisWeek: false, priority: false, overdue: false, attention: false };
    const quick = [
      ["All", base.length, !(f.status || f.thisWeek || f.priority || f.overdue || f.attention), {}],
      ["Blocked", base.filter((i) => i.status === "Red").length, f.status === "Red", { status: "Red" }],
      ["Needs attention", base.filter(needsAttention).length, f.attention, { attention: true }],
      ["This week", base.filter((i) => i.thisWeek).length, f.thisWeek, { thisWeek: true }],
      ["Priorities", base.filter((i) => i.priority).length, f.priority, { priority: true }],
      ["Overdue", base.filter(isOverdue).length, f.overdue, { overdue: true }],
    ];
    const pills = el("div", { class: "qpills" }, quick.map(([label, n, on, patch]) => el("button", { type: "button", class: "qpill" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false",
      onclick: () => { Object.assign(state.f, quickOff, patch); syncFilters(); syncHash(); render(); } }, label, el("span", { class: "qn" }, String(n)))));
    const groupOpts = done
      ? [["none", "No grouping"], ["completed", "Group by quarter completed"], ["pillar", "Group by pillar"], ["owner", "Group by owner"], ["area", "Group by area"]]
      : [["none", "No grouping"], ["pillar", "Group by pillar"], ["owner", "Group by owner"], ["status", "Group by status"], ["area", "Group by area"], ["due", "Group by due date"]];
    const groupSel = el("select", { "aria-label": "Group by", onchange: (e) => { itemsGroups[scope] = e.target.value; localStorage.setItem(done ? "completedGroup" : "itemsGroup", e.target.value); render(); } },
      groupOpts.map(([v, t]) => el("option", { value: v, selected: v === itemsGroup }, t)));

    // Scope switch: counts ignore the quick filters so each tab shows what it would give.
    state.f = { ...f, status: "", thisWeek: false, priority: false, overdue: false, attention: false, completed: true };
    const every = visible();
    state.f = f;
    const nDone = every.filter((i) => i.status === "Done").length;
    const clearQuick = { status: "", thisWeek: false, priority: false, overdue: false, attention: false };
    const scopes = [
      ["Active", every.length - nDone, scope === "items" && !f.completed, () => drill({ completed: false, status: f.status === "Done" ? "" : f.status }, "items")],
      ["Completed", nDone, done, () => drill({ ...clearQuick, completed: false }, "completed")],
      ["All", every.length, scope === "items" && f.completed, () => drill({ completed: true }, "items")],
    ];
    const scopeBar = el("div", { class: "seg", role: "tablist" }, scopes.map(([label, n, on, go]) => el("button", { type: "button", class: "seg-btn" + (on ? " on" : ""),
      role: "tab", "aria-selected": on ? "true" : "false", onclick: go }, label, el("span", { class: "qn" }, String(n)))));

    const sorted = [...items].sort((a, b) => itemSort.dir * ITEM_SORTS[itemSort.key](a, b));
    const head = el("div", { class: "itbl-head" }, [["status", ""], ["title", "Item"], ["pillar", "Pillar"], ["owner", "Owner"], ["area", "Area"], ["region", "Region"], [done ? "completed" : "due", done ? "Completed" : "Due"]]
      .map(([key, label]) => el("button", { type: "button", class: "ih ih-" + key + (itemSort.key === key ? " on" : ""), title: `Sort by ${key}`,
        onclick: () => { itemSort.dir = itemSort.key === key ? -itemSort.dir : 1; itemSort.key = key; render(); } },
        label || "●", itemSort.key === key ? el("span", { class: "arrow" }, itemSort.dir > 0 ? " ↑" : " ↓") : null)));

    const chip = (v, key) => (v ? el("span", { class: "tag link", title: `Filter by ${v}`, onclick: (e) => { e.stopPropagation(); setFilter(key, v); } }, v) : el("span", { class: "muted" }, "–"));
    const row = (i) => el("div", { class: "itbl-row editable", tabindex: "0", role: "button", onclick: () => showItem(i), onkeydown: (e) => { if (e.key === "Enter") showItem(i); } },
      el("span", { class: "dot " + CLS[i.status], title: i.status, role: "img", "aria-label": i.status }),
      el("div", { class: "ic-title" }, el("strong", {}, i.title), " ", tags(i), i.notes ? el("div", { class: "ic-notes" }, i.notes) : null),
      el("div", { class: "ic-pillar" }, chip(i.pillar, "pillar")),
      el("div", { class: "ic-owner" }, i.owner ? el("strong", { class: "link", title: `Filter by ${i.owner}`, onclick: (e) => { e.stopPropagation(); setFilter("owner", i.owner); } }, i.owner) : el("span", { class: "muted" }, "–")),
      el("div", { class: "ic-area" }, chip(i.area, "area")),
      el("div", { class: "ic-region" }, regionTokens(i.region).length ? regionTokens(i.region).map((r) => chip(r, "region")) : el("span", { class: "muted" }, "–")),
      el("div", { class: "ic-due" + (isOverdue(i) ? " over" : "") }, done ? (i.completed ? fmtDate(i.completed) : el("span", { class: "muted" }, "No date"))
        : i.status === "Done" ? (i.completed ? `Done ${fmtShort(i.completed)}` : "Done") : i.due ? fmtDate(i.due) : el("span", { class: "muted" }, "No date")));
    let body;
    if (!sorted.length) body = el("div", { class: "empty" }, done ? "Nothing completed yet. Items you mark Done will appear here." : "No items match the current filters.");
    else if (itemsGroup === "none") body = el("div", { class: "itbl" }, head, sorted.map(row));
    else {
      const def = GROUPS[itemsGroup];
      const groups = group(sorted, def.key);
      body = el("div", {}, Object.keys(groups).sort(def.order).map((k) => {
        const gkey = `${itemsGroup}|${k}`;
        const box = el("details", { class: "igroup", open: !closedGroups.has(gkey) },
          el("summary", {}, el("strong", {}, def.label(k)), el("small", {}, plural(groups[k].length, "item")), done ? null : el("div", { class: "igroup-bar" }, stack(rag(groups[k])))),
          el("div", { class: "itbl" }, groups[k].map(row)));
        box.addEventListener("toggle", () => { box.open ? closedGroups.delete(gkey) : closedGroups.add(gkey); });
        return box;
      }));
      body.prepend(el("div", { class: "itbl itbl-headonly" }, head));
    }

    const thisMonth = items.filter((i) => i.completed && i.completed.slice(0, 7) === today.slice(0, 7)).length;
    const thisQuarter = items.filter((i) => i.completed && quarterOf(i.completed) === quarterOf(today)).length;
    return el("div", {},
      el("div", { class: "items-top" }, scopeBar,
        el("div", { class: "items-actions" }, el("small", { class: "muted" }, `${items.length} shown`),
          addBtn("+ Add item", () => openForm("items", {})), addBtn("Import links", openImportLinks), addBtn("Clear this-week flags", clearWeek),
          el("button", { class: "btn sm ghost", onclick: () => exportCsv(sorted) }, "Export CSV"))),
      el("div", { class: "items-bar" },
        done ? el("p", { class: "muted items-sum" }, `${items.length} completed · ${thisMonth} this month · ${thisQuarter} this quarter. To reopen an item, open it and change its status.`) : pills, groupSel),
      body);
  }

  function renderCompleted(items) {
    return renderItems(items, "completed");
  }

  // ---------- activity drawer (opened from the header, not a tab) ----------
  let activityKind = "all";
  let activityLog = null;
  const KINDS = { all: "All", items: "Items", milestones: "Milestones", wins: "Wins", kpis: "Numbers", pillars: "Pillars" };
  const dayLabel = (iso) => {
    const d = new Date(iso), t = new Date();
    if (d.toDateString() === t.toDateString()) return "Today";
    t.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return "Yesterday";
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  };

  async function openActivity() {
    $("activity").hidden = false;
    $("scrim").hidden = false;
    $("activityBody").replaceChildren(el("p", { class: "muted" }, "Loading..."));
    try { activityLog = await (await fetch("/api/changelog?limit=300")).json(); } catch { activityLog = null; }
    renderActivity();
    $("activityClose").focus();
  }

  function closeActivity() {
    $("activity").hidden = true;
    $("scrim").hidden = true;
    $("activityBtn").focus();
  }

  function renderActivity() {
    if (!Array.isArray(activityLog)) { $("activityBody").replaceChildren(el("div", { class: "empty" }, "Could not load activity.")); return; }
    $("activityKinds").replaceChildren(...Object.entries(KINDS).map(([k, label]) => el("button", { type: "button", class: "qpill" + (activityKind === k ? " on" : ""),
      "aria-pressed": activityKind === k ? "true" : "false", onclick: () => { activityKind = k; renderActivity(); } }, label)));
    const shown = activityLog.filter((e) => activityKind === "all" || e.collection === activityKind);
    const days = group(shown, (e) => dayLabel(e.ts));
    $("activityBody").replaceChildren(...(shown.length
      ? Object.entries(days).map(([day, list]) => el("section", { class: "act-day" },
        el("h4", {}, day, el("small", {}, plural(list.length, "change"))),
        list.map((e) => el("div", { class: "act-entry" },
          el("i", { class: "mini-avatar" }, initials(e.actor || "?")),
          el("div", { class: "act-main" },
            el("div", {}, el("strong", {}, e.actor), ` ${e.action} `, el("span", { class: "tag" }, KINDS[e.collection] || e.collection), " ", el("strong", {}, e.title)),
            e.changes ? el("div", { class: "act-chg" }, Object.entries(e.changes).map(([k, [a, b]]) => el("span", { class: "act-chip" }, el("b", {}, `${k}: `), a ? `${a} → ${b}` : String(b)))) : null),
          el("time", { class: "muted", datetime: e.ts }, new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })))))) 
      : [el("div", { class: "empty" }, "No activity yet. Changes made from now on will appear here.")]));
  }
  $("activityBtn").addEventListener("click", openActivity);
  $("activityClose").addEventListener("click", closeActivity);
  $("scrim").addEventListener("click", closeActivity);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("activity").hidden && !dlg.open) closeActivity(); });

  // ---------- Jordan: private to-do list and updates (own file on the server, never counted in any stats) ----------
  let jordan = null, jordanErr = "", jordanLoading = false, jQueue = Promise.resolve();
  const jDraft = { todo: "", todoDue: "", alex: "", team: "" };
  const jEditing = new Set();
  let jTab = localStorage.getItem("jTab") || "todo";
  const jScope = { todo: "open", alex: "waiting", team: "waiting" };
  let jDrag = null;
  const newId = () => Math.random().toString(36).slice(2, 10);
  const jRender = () => $("view").replaceChildren(renderJordan());
  const syncJordanTab = () => { $("jordanTab").hidden = !(state.canEdit && state.canJordan); };

  async function loadJordan() {
    if (jordanLoading) return;
    jordanLoading = true;
    try { jordan = await api("GET", "/api/jordan"); jordanErr = ""; } catch (err) { jordanErr = err.message; }
    jordanLoading = false;
    if (state.view === "jordan" && !state.exec) render();
  }

  // Changes are applied locally first; saves are queued so they reach the server in order.
  function jSave(focusId, rerender = true) {
    if (rerender) { jRender(); if (focusId) $(focusId)?.focus(); }
    jQueue = jQueue.then(() => jordan && api("PUT", "/api/jordan", jordan))
      .catch((err) => { alert("Could not save: " + err.message); jordan = null; if (state.view === "jordan") render(); });
  }

  const jBtn = (label, onclick, cls = "ju-link") => el("button", { type: "button", class: cls, onclick }, label);

  const jSeg = (options, current, onPick) => el("div", { class: "seg", role: "tablist" }, options.map(([key, label, n]) => el("button", { type: "button", class: "seg-btn" + (current === key ? " on" : ""),
    role: "tab", "aria-selected": current === key ? "true" : "false", onclick: () => onPick(key) }, label, el("span", { class: "qn" }, String(n)))));

  // The list order is the order you set: drag the grip or use the arrows. Completed items keep their place if reopened.
  function jTodoPanel() {
    const all = jordan.todos;
    const open = all.filter((t) => !t.done);
    const done = all.filter((t) => t.done).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
    const scope = jScope.todo;
    const shown = scope === "open" ? open : scope === "done" ? done : all;
    const canOrder = scope !== "done";
    const text = el("input", { id: "jTodoText", type: "text", placeholder: "Add a to-do...", maxlength: "300", "aria-label": "New to-do", value: jDraft.todo, oninput: (e) => { jDraft.todo = e.target.value; } });
    const due = el("input", { type: "date", "aria-label": "Due date", value: jDraft.todoDue, onchange: (e) => { jDraft.todoDue = e.target.value; } });
    const add = () => {
      const t = jDraft.todo.trim();
      if (!t) return;
      all.push({ id: newId(), text: t, due: jDraft.todoDue, done: false, star: false, created: today, doneAt: "" });
      jDraft.todo = ""; jDraft.todoDue = "";
      jScope.todo = scope === "done" ? "open" : scope;
      jSave("jTodoText");
    };
    text.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    const moveTo = (from, to) => { all.splice(to, 0, all.splice(from, 1)[0]); jSave(); };
    const step = (t, dir) => { const n = shown[shown.indexOf(t) + dir]; if (n) moveTo(all.indexOf(t), all.indexOf(n)); };
    const arrow = (t, n, dir) => (canOrder
      ? el("button", { type: "button", class: "jt-btn", title: dir < 0 ? "Move up" : "Move down", "aria-label": dir < 0 ? "Move up" : "Move down", disabled: dir < 0 ? n === 0 : n === shown.length - 1, onclick: () => step(t, dir) }, dir < 0 ? "\u25b2" : "\u25bc")
      : el("span"));
    const row = (t, n) => {
      const li = el("li", { class: "jt" + (t.done ? " done" : "") },
        canOrder ? el("span", { class: "jt-grip", draggable: "true", title: "Drag to reorder", "aria-hidden": "true",
          ondragstart: (e) => { jDrag = t; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.setDragImage(li, 10, 10); },
          ondragend: () => { jDrag = null; } }, "\u22ee\u22ee") : el("span"),
        el("input", { type: "checkbox", checked: t.done, "aria-label": "Done", onchange: (e) => { t.done = e.target.checked; t.doneAt = t.done ? today : ""; jSave(); } }),
        el("span", { class: "jt-rank" }, scope === "open" ? String(n + 1) : ""),
        el("input", { class: "jt-text", type: "text", value: t.text, maxlength: "300", "aria-label": "To-do", onchange: (e) => { const v = e.target.value.trim(); if (v) t.text = v; jSave(null, false); } }),
        t.done ? el("span", { class: "muted jt-doneat" }, t.doneAt ? `Done ${fmtShort(t.doneAt)}` : "Done")
          : el("input", { class: "jt-due" + (t.due && t.due < today ? " over" : ""), type: "date", value: t.due, "aria-label": "Due date", onchange: (e) => { t.due = e.target.value; jSave(); } }),
        el("button", { type: "button", class: "jt-btn jt-star" + (t.star ? " on" : ""), title: "Mark as important", "aria-pressed": t.star ? "true" : "false", onclick: () => { t.star = !t.star; jSave(); } }, t.star ? "\u2605" : "\u2606"),
        arrow(t, n, -1), arrow(t, n, 1),
        el("button", { type: "button", class: "jt-btn jt-x", title: "Delete", "aria-label": "Delete to-do", onclick: () => { jordan.todos = jordan.todos.filter((x) => x !== t); jSave(); } }, "\u00d7"));
      li.addEventListener("dragover", (e) => { if (jDrag && jDrag !== t) { e.preventDefault(); li.classList.add("drop"); } });
      li.addEventListener("dragleave", () => li.classList.remove("drop"));
      li.addEventListener("drop", (e) => { e.preventDefault(); li.classList.remove("drop"); if (jDrag && jDrag !== t) moveTo(all.indexOf(jDrag), all.indexOf(t)); jDrag = null; });
      return li;
    };
    const byDue = (a, b) => (b.star - a.star) || (a.due || "9999").localeCompare(b.due || "9999");
    const empty = { open: "Nothing open. Add something above.", done: "Nothing completed yet. Tick a to-do to move it here.", all: "No to-dos yet." }[scope];
    return el("div", {},
      el("div", { class: "jcompose" }, text, due, el("button", { type: "button", class: "btn", onclick: add }, "Add")),
      el("div", { class: "items-top" },
        jSeg([["open", "Open", open.length], ["done", "Done", done.length], ["all", "All", all.length]], scope, (k) => { jScope.todo = k; jRender(); }),
        el("div", { class: "items-actions" },
          canOrder && open.length > 1 ? el("button", { type: "button", class: "btn sm ghost", title: "Starred first, then earliest due date", onclick: () => { all.sort(byDue); jSave(); } }, "Sort by due date") : null,
          scope === "done" && done.length ? el("button", { type: "button", class: "btn sm ghost", onclick: () => { if (confirm(`Remove ${done.length} done to-dos?`)) { jordan.todos = all.filter((t) => !t.done); jSave(); } } }, "Clear done") : null)),
      shown.length
        ? el("div", { class: "jtbl" },
          el("div", { class: "jt jt-head" }, el("span"), el("span"), el("span", { class: "jt-rank" }, scope === "open" ? "#" : ""), el("span", {}, "To-do"), el("span", {}, scope === "done" ? "Completed" : "Due"), el("span"), el("span"), el("span"), el("span")),
          el("ul", {}, shown.map(row)))
        : el("div", { class: "empty" }, empty));
  }

  function jUpdatesPanel(audience, title, hint) {
    const mine = jordan.updates.filter((u) => u.audience === audience).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const unsent = mine.filter((u) => !u.sent), sent = mine.filter((u) => u.sent);
    const scope = jScope[audience];
    const shown = scope === "waiting" ? unsent : scope === "sent" ? sent : mine;
    const id = "jUpd-" + audience;
    const box = el("textarea", { id, rows: "3", maxlength: "1500", placeholder: hint, "aria-label": title, value: jDraft[audience], oninput: (e) => { jDraft[audience] = e.target.value; } });
    const add = () => {
      const t = jDraft[audience].trim();
      if (!t) return;
      jordan.updates.unshift({ id: newId(), audience, text: t, date: today, sent: false });
      jDraft[audience] = "";
      jScope[audience] = scope === "sent" ? "waiting" : scope;
      jSave(id);
    };
    box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(); });
    const copy = async (e) => {
      const lines = [...unsent].reverse().map((u) => "- " + u.text.replace(/\n/g, "\n  ")).join("\n");
      const btn = e.currentTarget;
      try { await navigator.clipboard.writeText(`${title} (${fmtDate(today)})\n${lines}`); btn.textContent = "Copied"; } catch { btn.textContent = "Copy failed"; }
      setTimeout(() => { btn.textContent = "Copy list"; }, 1500);
    };
    const edit = (u) => {
      const area = el("textarea", { rows: "4", maxlength: "1500", "aria-label": "Edit update", value: u.text });
      return el("li", { class: "ju" }, area, el("div", { class: "ju-actions" },
        el("button", { type: "button", class: "btn sm", onclick: () => { const v = area.value.trim(); if (v) u.text = v; jEditing.delete(u.id); jSave(); } }, "Save"),
        el("button", { type: "button", class: "btn sm ghost", onclick: () => { jEditing.delete(u.id); jRender(); } }, "Cancel")));
    };
    const entry = (u) => jEditing.has(u.id) ? edit(u) : el("li", { class: "ju" + (u.sent ? " sent" : "") },
      el("div", { class: "ju-meta" }, el("span", { class: "ju-when" },
        el("input", { type: "checkbox", checked: u.sent, title: u.sent ? "Discussed. Untick to put it back" : "Tick when discussed", "aria-label": "Discussed", onchange: (e) => { u.sent = e.target.checked; jSave(); } }),
        u.date ? fmtDate(u.date) : "", " ", el("span", { class: "tag" }, u.sent ? "Discussed" : "To discuss")),
        el("span", { class: "ju-actions" },
          jBtn("Edit", () => { jEditing.add(u.id); jRender(); }),
          jBtn("Delete", () => { if (confirm("Delete this update?")) { jordan.updates = jordan.updates.filter((x) => x !== u); jSave(); } }))),
      el("p", { class: "ju-text" }, u.text));
    return el("div", {},
      el("div", { class: "jcompose jcompose-col" }, box,
        el("div", { class: "jp-add" }, el("button", { type: "button", class: "btn", onclick: add }, "Add update"), el("small", { class: "muted" }, "Ctrl/Cmd + Enter"))),
      el("div", { class: "items-top" },
        jSeg([["waiting", "To discuss", unsent.length], ["sent", "Discussed", sent.length], ["all", "All", mine.length]], scope, (k) => { jScope[audience] = k; jRender(); }),
        unsent.length && scope !== "sent" ? el("div", { class: "items-actions" }, el("button", { type: "button", class: "btn sm ghost", onclick: copy }, "Copy list"),
          el("button", { type: "button", class: "btn sm ghost", onclick: () => { unsent.forEach((u) => { u.sent = true; }); jSave(); } }, "All discussed")) : null),
      shown.length ? el("ul", { class: "jlist" }, shown.map(entry))
        : el("div", { class: "empty" }, scope === "sent" ? "Nothing marked as discussed yet." : scope === "waiting" ? "Nothing left to discuss." : "No updates yet."));
  }

  function renderJordan() {
    const head = el("div", { class: "jhead" }, el("h2", {}, "Jordan"),
      el("p", { class: "muted" }, "Private workspace, only visible when unlocked. Nothing here counts towards the site numbers, Executive view or Activity log."));
    if (!(state.canEdit && state.canJordan)) {
      return el("div", {}, head, el("div", { class: "empty" }, state.auth.user ? "This area is private to the site owner."
        : ["This area is private. ", el("button", { class: "btn", onclick: async () => { if (await ensureEdit()) render(); } }, "Unlock")]));
    }
    if (!jordan) {
      if (!jordanErr) loadJordan();
      return el("div", {}, head, jordanErr
        ? el("div", { class: "empty" }, `Could not load: ${jordanErr} `, el("button", { class: "btn ghost", onclick: () => { jordanErr = ""; render(); } }, "Retry"))
        : el("div", { class: "empty" }, "Loading..."));
    }
    const waiting = (a) => jordan.updates.filter((u) => u.audience === a && !u.sent).length;
    const openTodos = jordan.todos.filter((t) => !t.done);
    const overdue = openTodos.filter((t) => t.due && t.due < today).length;
    const tabs = [["todo", "My to-do", openTodos.length, "open", overdue ? `${overdue} overdue` : ""], ["alex", "Updates for Alex", waiting("alex"), "to discuss", ""], ["team", "Team updates", waiting("team"), "to discuss", ""]];
    if (!tabs.some(([k]) => k === jTab)) jTab = "todo";
    const body = jTab === "todo" ? jTodoPanel()
      : jTab === "alex" ? jUpdatesPanel("alex", "Updates for Alex", "What do you want to raise with Alex? Wins, risks, asks...")
        : jUpdatesPanel("team", "Team updates", "What do you want to cover with the team?");
    return el("div", {}, head,
      el("div", { class: "jtabs", role: "tablist" }, tabs.map(([k, label, n, unit, warn]) => el("button", { type: "button", class: "jtab" + (jTab === k ? " on" : ""), role: "tab", "aria-selected": jTab === k ? "true" : "false",
        onclick: () => { jTab = k; localStorage.setItem("jTab", k); jRender(); } },
      el("span", { class: "jtab-n" }, String(n)), el("span", { class: "jtab-l" }, label, el("small", {}, ` ${unit}`), warn ? el("small", { class: "jtab-warn" }, ` \u00b7 ${warn}`) : null)))),
      el("div", { class: "jbody" }, body));
  }

  function renderExec() {
    const all = state.data.items;
    const items = all.filter((i) => i.status !== "Done");
    const completed = all.length - items.length;
    const r = rag(items);
    const ms = allMilestones();
    const msDone = ms.filter((m) => m.status === "Done").length;
    const wins = [...state.data.wins].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const bigTile = (n, l, cls = "") => el("div", { class: "x-tile " + cls }, el("div", { class: "n" }, String(n)), el("div", { class: "l" }, l));
    const section = (title, ...kids) => el("section", { class: "x-sec" }, el("h3", {}, title), kids);
    const msSorted = [...ms].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    const msCols = {};
    msSorted.forEach((m) => { const q = m.date ? quarterOf(m.date) : "No date"; (msCols[q] = msCols[q] || []).push(m); });
    const msOrder = Object.keys(msCols).sort((a, b) => (a === "No date") - (b === "No date") || a.localeCompare(b));
    const msBlock = ms.length ? [el("h4", { class: "x-sub" }, "Milestones"), el("div", { class: "x-roadmap" }, msOrder.map((q) => el("div", { class: "x-q" },
      el("div", { class: "x-qhead" }, el("strong", {}, q), el("small", {}, plural(msCols[q].length, "milestone"))),
      msCols[q].map((m) => el("div", { class: "x-m " + msState(m) },
        el("div", { class: "x-mtop" }, el("span", { class: "x-mdate" }, m.date ? fmtDate(m.date) : "No date"), el("span", { class: "rm-pill " + msState(m) }, msState(m) === "done" ? "✓ Achieved" : msWhen(m))),
        el("div", { class: "x-mtitle" }, m.title), m.owner ? el("div", { class: "muted" }, m.owner) : null)))))] : null;
    const pillarCard = (p) => {
      const list = items.filter((i) => i.pillar === p.id);
      const pr = rag(list);
      const doneN = all.filter((i) => i.pillar === p.id && i.status === "Done").length;
      const focus = list.filter((i) => i.thisWeek);
      const prio = (focus.length ? focus : list.filter((i) => i.priority)).slice(0, 3);
      return el("div", { class: "x-pillar" },
        el("div", { class: "x-ptop" }, el("span", { class: "tag" }, p.id), el("strong", {}, p.name)),
        el("p", { class: "muted" }, `Leader: ${p.leader || "Unassigned"}`), stack(pr),
        el("p", { class: "x-counts" }, `${list.length} active · ${doneN} completed · ${pr.Red} blocked`),
        prio.length ? [el("div", { class: "x-label" }, "This week"), el("ul", { class: "x-prio" }, prio.map((i) => el("li", {}, i.title)))] : null);
    };
    return el("div", { class: "exec-view" },
      el("header", { class: "x-head" },
        el("div", {}, el("div", { class: "x-eyebrow" }, "Team update"), el("h2", {}, state.data.team.name), el("p", { class: "muted" }, `${fmtDate(today)} · Lead: ${state.data.team.lead}`))),
      el("div", { class: "x-tiles" }, bigTile(items.length, "Active work items"), bigTile(completed, "Completed", "done"), bigTile(r.Red, "Blocked", r.Red ? "x-alert" : ""),
        bigTile(wins.length, "Key wins"), bigTile(`${msDone}/${ms.length}`, "Milestones achieved")),
      section("At a glance", el("div", { class: "dash two" }, donut(r), breakdown("By pillar", items, (i) => i.pillar, (k) => pillarLabel(k)),
        dueByMonthPanel(items), winsByPillarPanel(), workloadPanel(items))),
      section("Wins & milestones", el("h4", { class: "x-sub" }, "Key wins"), el("div", { class: "x-wins" }, wins.slice(0, 9).map((w) => el("div", { class: "x-win" },
        el("span", { class: "tag" }, w.unit || "Team"), el("strong", {}, w.title), el("p", {}, w.impact || w.detail)))),
        wins.length > 9 ? el("p", { class: "muted" }, `${wins.length - 9} more in the full view.`) : null, msBlock),
      section("Progress by pillar", el("div", { class: "x-pillars" }, pillars().map(pillarCard))),
      state.data.kpis.length ? section("Headline numbers", el("div", { class: "kpis" }, state.data.kpis.map(kpiCard))) : null,
      el("div", { class: "x-cols" }, deliveredPanel(), trendPanel()),
      statusLegend(),
      el("p", { class: "muted x-foot" }, `Generated ${fmtDate(today)} from Team Showcase`));
  }

  function render() {
    renderFilterUi();
    document.body.classList.toggle("v-jordan", state.view === "jordan" && !state.exec);
    if (state.exec) { $("view").replaceChildren(renderExec()); $("count").textContent = ""; return; }
    if (state.view === "jordan") { $("view").replaceChildren(renderJordan()); $("count").textContent = ""; return; }
    const items = visible(state.view === "completed");
    const view = { overview: renderOverview, pillars: renderPillars, owners: renderOwners, milestones: renderMilestones, items: renderItems, completed: renderCompleted }[state.view];
    $("view").replaceChildren(view(items));
    const open = state.data.items.filter((i) => i.status !== "Done").length;
    const counts = {
      milestones: [allMilestones().filter(milestoneOk).length, allMilestones().length, `milestones · ${state.data.wins.filter(winOk).length} of ${state.data.wins.length} wins`],
      completed: [items.length, state.data.items.length - open, "completed items"],
    }[state.view] || [items.length, state.f.completed ? state.data.items.length : open, "items"];
    $("count").textContent = `${counts[0]} of ${counts[1]} ${counts[2]}`;
  }

  // ---------- dialogs and forms ----------
  const dlg = $("dlg");
  function openDlg(node) { dlg.replaceChildren(node); if (!dlg.open) dlg.showModal(); }
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  function showItem(i) {
    const dl = el("dl", {});
    [["Status", state.editMode ? "" : i.status], ["Pillar", i.pillar ? linkTo(pillarLabel(i.pillar), { pillar: i.pillar }, "pillars") : ""],
      ["Area", i.area ? linkTo(i.area, { area: i.area }, "items") : ""], ["Owner", i.owner ? linkTo(i.owner, { owner: i.owner }, "owners") : ""],
      ["Region", i.region ? regionTokens(i.region).flatMap((r, n) => [n ? " / " : "", linkTo(r, { region: r }, "items")]) : ""],
      ["Started", i.started ? fmtDate(i.started) : ""], ["Due", i.due ? fmtDate(i.due) : ""], ["Completed", i.completed ? fmtDate(i.completed) : ""],
      ["Milestone", (() => { const m = allMilestones().find((x) => x.item && x.item.id === i.id); return m ? linkTo(m.title, {}, "milestones") : ""; })()],
      ["Last changed", i.updatedAt ? fmtDate(i.updatedAt.slice(0, 10)) : ""]]
      .filter(([, v]) => v).forEach(([k, v]) => dl.append(el("dt", {}, k), el("dd", {}, v)));
    const link = /^https?:\/\//.test(i.link || "") ? el("p", {}, el("a", { href: i.link, target: "_blank", rel: "noopener noreferrer" }, "Open link")) : null;
    const points = (i.notes || "").split(/;\s+/).filter(Boolean);
    const notes = points.length > 1 ? el("ul", { class: "notes" }, points.map((p) => el("li", {}, p))) : el("p", { class: "notes" }, i.notes || "");
    const updates = i.updates || [];
    const input = el("input", { type: "text", placeholder: "Add a progress update...", maxlength: "1000" });
    const postUpdate = async () => {
      const text = input.value.trim();
      if (!text || !(await ensureEdit())) return;
      try { const updated = await api("POST", `/api/items/${i.id}/updates`, { text }); await refresh(); showItem(updated); } catch (err) { alert(err.message); }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); postUpdate(); } });
    const timeline = el("div", { class: "updates" }, el("h4", {}, "Progress updates"),
      updates.length ? el("ul", {}, updates.map((u) => el("li", {}, el("strong", {}, fmtDate(u.date)), ` ${u.text} `, el("span", { class: "muted" }, `(${u.by})`))))
        : el("p", { class: "muted" }, "No progress updates yet."),
      state.editMode ? el("div", { class: "addupd" }, input, el("button", { class: "btn sm", type: "button", onclick: postUpdate }, "Add")) : null);
    const statusRow = !state.editMode ? null : el("div", { class: "statusrow" }, el("span", { class: "muted" }, "Status"),
      RAG.map((s) => el("button", { type: "button", class: "spill" + (s === i.status ? " on" : ""), "data-s": s, title: MEANING[s], "aria-pressed": s === i.status ? "true" : "false",
        onclick: () => { if (s !== i.status) patchItem(i, { status: s }); } }, s)));
    openDlg(el("div", {}, el("h3", {}, i.title), el("p", {}, tags(i)), statusRow, dl, notes, link, timeline,
      el("div", { class: "btns" },
        state.editMode ? el("div", { class: "btns-left" },
          el("button", { class: "btn ghost", onclick: () => patchItem(i, { thisWeek: !i.thisWeek }) }, i.thisWeek ? "Not working on this week" : "Working on this week"),
          el("button", { class: "btn ghost", onclick: () => patchItem(i, { milestone: !i.milestone }) }, i.milestone ? "Remove from milestones" : "Mark as milestone")) : null,
        state.editMode ? el("button", { class: "btn", onclick: () => openForm("items", i) }, "Edit") : null,
        el("button", { class: "btn ghost", onclick: () => dlg.close() }, "Close"))));
  }

  const pillarField = ["pillar", "Pillar", "pillar"];
  const SPECS = {
    items: [["title", "Title", "text"], pillarField, ["area", "Area", "text", "areas"], ["owner", "Owner", "text", "owners"], ["status", "Status", "select", RAG],
      ["started", "Start date", "date"], ["due", "Due date", "date"], ["completed", "Completed date", "date"],
      ["region", "Region", "text", "regions"], ["notes", "Notes", "textarea"], ["link", "Link (e.g. Confluence)", "text"],
      ["thisWeek", "Working on this week", "checkbox"], ["priority", "Priority", "checkbox"], ["blocker", "Escalation / blocker", "checkbox"],
      ["milestone", "Show on the Milestones timeline", "checkbox"], ["internal", "Internal only (hide from executive view)", "checkbox"]],
    milestones: [["title", "Title", "text"], ["date", "Date", "date"], pillarField, ["owner", "Owner", "text", "owners"], ["status", "Status", "select", ["Upcoming", "At risk", "Done"]],
      ["itemId", "Linked item (status and date follow it)", "options", () => [["", "None"], ...[...state.data.items].sort(byTitle).map((i) => [i.id, `${i.title} (${i.owner || "unassigned"}, ${i.pillar})`])]], ["notes", "Notes", "textarea"]],
    wins: [["title", "Title", "text"], ["detail", "Detail", "textarea"], ["impact", "Impact (e.g. 10 merchants live)", "text"], ["date", "Date", "date"], pillarField, ["unit", "Business unit", "text", "units"]],
    kpis: [["label", "Label", "text"], ["auto", "Value source", "options", KPI_SOURCES], ["value", "Value", "number"], ["target", "Target (optional)", "number"], ["unit", "Unit", "text"], ["note", "Note", "text"], pillarField],
    pillars: [["name", "Name", "text"], ["leader", "Pillar leader", "text", "owners"], ["focus", "Focus", "textarea"]],
  };
  const NOUN = { items: "item", milestones: "milestone", wins: "win", kpis: "KPI", pillars: "pillar" };

  async function openForm(coll, rec) {
    if (!(await ensureEdit())) return;
    const d = state.data;
    const lists = {
      owners: uniq([...d.items.map((i) => i.owner), ...d.pillars.map((p) => p.leader)]), areas: uniq(d.items.map((i) => i.area)),
      regions: uniq(d.items.map((i) => i.region)), units: uniq(d.wins.map((w) => w.unit)),
    };
    const fields = SPECS[coll].map(([name, label, type, extra]) => {
      const cur = rec[name] ?? (name === "status" && coll === "items" ? "Amber" : name === "status" ? "Upcoming" : "");
      let input;
      if (type === "textarea") input = el("textarea", { name }, cur);
      else if (type === "select") input = el("select", { name }, extra.map((o) => el("option", { value: o, selected: o === cur }, o)));
      else if (type === "options") input = el("select", { name }, (typeof extra === "function" ? extra() : extra).map(([v, t]) => el("option", { value: v, selected: v === cur }, t)));
      else if (type === "pillar") input = el("select", { name }, el("option", { value: "" }, "Cross-pillar"), pillars().map((p) => el("option", { value: p.id, selected: p.id === cur }, `${p.id} ${p.name}`)));
      else if (type === "checkbox") return el("label", { class: "chk" }, el("input", { type: "checkbox", name, checked: !!cur }), label);
      else input = el("input", { name, type, value: cur, step: type === "number" ? "any" : null, list: extra ? `dl-${extra}` : null, autocomplete: "off" });
      return el("label", {}, label, input);
    });
    const error = el("div", { class: "err" });
    const datalists = Object.entries(lists).map(([id, vals]) => el("datalist", { id: `dl-${id}` }, vals.map((v) => el("option", { value: v }))));
    const form = el("form", {}, el("h3", {}, `${rec.id ? "Edit" : "Add"} ${NOUN[coll]}`), fields, datalists, error,
      el("div", { class: "btns" },
        rec.id && coll !== "pillars" ? el("button", { type: "button", class: "btn danger btns-left", onclick: () => { dlg.close(); remove(coll, rec.id, rec.title || rec.label); } }, "Delete") : null,
        el("button", { type: "button", class: "btn ghost", onclick: () => dlg.close() }, "Cancel"), el("button", { class: "btn" }, "Save")));
    if (coll === "kpis") {
      const lock = () => { for (const n of ["value", "target", "unit", "note"]) form.elements[n].disabled = !!form.elements.auto.value; };
      form.elements.auto.addEventListener("change", lock);
      lock();
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { id: rec.id };
      for (const [name, , type] of SPECS[coll]) {
        const f = form.elements[name];
        body[name] = type === "checkbox" ? f.checked : f.value;
      }
      try {
        if (coll === "pillars") await api("PUT", `/api/pillars/${rec.id}`, body);
        else await api("POST", `/api/${coll}`, body);
        dlg.close();
        await refresh();
      } catch (err) { error.textContent = err.message; }
    });
    openDlg(form);
  }

  async function remove(coll, id, name) {
    if (!(await ensureEdit())) return;
    if (!confirm(`Delete "${name}"?`)) return;
    try { await api("DELETE", `/api/${coll}?id=${encodeURIComponent(id)}`); await refresh(); } catch (err) { alert(err.message); }
  }

  // ---------- import and export ----------
  const csvCell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };

  function exportCsv(items) {
    const cols = [["Title", "title"], ["Pillar", "pillar"], ["Area", "area"], ["Owner", "owner"], ["Status", "status"], ["Region", "region"], ["Started", "started"],
      ["Due", "due"], ["Completed", "completed"], ["Priority", "priority"], ["Blocker", "blocker"], ["Link", "link"], ["Notes", "notes"]];
    const lines = [cols.map(([h]) => csvCell(h)).join(","), ...items.map((i) => cols.map(([, k]) => csvCell(i[k])).join(","))];
    const a = el("a", { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })), download: `team-items-${today}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function openImportLinks() {
    if (!(await ensureEdit())) return;
    const area = el("textarea", { rows: "10", placeholder: "Item title, https://confluence.example/page\nOne item per line. Use a comma, tab or | between the title and the link." });
    const out = el("div", { class: "err" });
    const form = el("form", {}, el("h3", {}, "Import Confluence links"), el("label", {}, "Item titles and links", area), out,
      el("div", { class: "btns" }, el("button", { type: "button", class: "btn ghost", onclick: () => dlg.close() }, "Close"), el("button", { class: "btn" }, "Import")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const rows = area.value.split("\n").map((l) => l.match(/^(.*?)[\t|,;]\s*(https?:\/\/\S+)\s*$/)).filter(Boolean).map((m) => ({ title: m[1].trim(), url: m[2] }));
      if (!rows.length) { out.textContent = "No valid lines found."; return; }
      try {
        const res = await api("POST", "/api/import-links", { rows });
        out.className = "ok";
        out.textContent = `Linked ${res.matched} of ${rows.length}.` + (res.unmatched.length ? ` Not matched (titles must match exactly): ${res.unmatched.join("; ")}` : "");
        await refresh();
      } catch (err) { out.className = "err"; out.textContent = err.message; }
    });
    openDlg(form);
  }

  // ---------- filters, edit mode, boot ----------
  function setFilter(key, value) {
    state.f[key] = value;
    syncFilters();
    syncHash();
    render();
  }

  // ---------- browser history (Back / Forward) ----------
  const VIEWS = ["overview", "pillars", "owners", "milestones", "items", "completed", "jordan"];
  // Completed is a scope of the Items page, so it lights up the Items tab.
  const tabFor = (v) => (v === "completed" ? "items" : v);
  const FILTER_KEYS = ["pillar", "owner", "status", "region", "area"];
  const FLAG_KEYS = ["priority", "thisWeek", "overdue", "attention", "completed"];

  function hashFor() {
    if (state.exec) return "#exec";
    const p = new URLSearchParams();
    FILTER_KEYS.forEach((k) => state.f[k] && p.set(k, state.f[k]));
    FLAG_KEYS.forEach((k) => state.f[k] && p.set(k, "1"));
    if (state.f.q) p.set("q", state.f.q);
    const qs = p.toString();
    return `#/${state.view}${qs ? "?" + qs : ""}`;
  }

  // Record the current page and filters as a history entry (or just update the current one).
  function syncHash(replace = false) {
    const h = hashFor();
    if (h === location.hash) return;
    history[replace ? "replaceState" : "pushState"](null, "", h);
  }

  function readHash() {
    if (location.hash === "#exec") return { exec: true };
    const m = location.hash.match(/^#\/([a-z]+)(?:\?(.*))?$/);
    const view = m && (m[1] === "wins" ? "milestones" : m[1]);
    if (!view || !VIEWS.includes(view)) return null;
    const p = new URLSearchParams(m[2] || "");
    const f = { ...EMPTY_FILTERS, q: p.get("q") || "" };
    FILTER_KEYS.forEach((k) => { f[k] = p.get(k) || ""; });
    FLAG_KEYS.forEach((k) => { f[k] = p.get(k) === "1"; });
    return { view, f };
  }

  async function applyHash() {
    if (!state.data) return;
    if (dlg.open) dlg.close();
    const h = readHash();
    const wantExec = !!(h && h.exec);
    if (wantExec !== state.exec) {
      state.exec = wantExec;
      document.body.classList.toggle("exec", wantExec);
      $("execBtn").textContent = wantExec ? "Full view" : "Executive view";
      if (wantExec) setEditMode(false);
      await refresh();
    }
    if (!wantExec) {
      state.view = h ? h.view : "overview";
      state.f = h ? h.f : { ...EMPTY_FILTERS };
      [...$("tabs").children].forEach((b) => b.classList.toggle("active", b.dataset.view === tabFor(state.view)));
    }
    syncFilters();
    render();
  }

  const FILTER_LABELS = {
    pillar: (v) => `Pillar ${v}`, owner: (v) => `Owner: ${v}`, status: (v) => `Status: ${v}`, region: (v) => `Region: ${v}`, area: (v) => `Area: ${v}`,
    priority: () => "Priorities only", thisWeek: () => "Working this week", overdue: () => "Overdue only", attention: () => "Needs attention", completed: () => "Including completed",
  };

  function renderFilterUi() {
    const active = Object.keys(FILTER_LABELS).filter((k) => state.f[k]);
    $("chips").replaceChildren(...active.map((k) => el("button", { class: "chip", title: "Remove this filter",
      onclick: () => setFilter(k, typeof EMPTY_FILTERS[k] === "boolean" ? false : "") }, `${FILTER_LABELS[k](state.f[k])} ✕`)));
    $("fBadge").textContent = String(active.length);
    $("fBadge").hidden = !active.length;
  }

  function fillSelect(id, values, label, current, text = (v) => v, countOf = () => null) {
    const sel = $(id);
    sel.replaceChildren(el("option", { value: "" }, label), ...values.map((v) => {
      const n = countOf(v);
      return el("option", { value: v, selected: v === current }, n == null ? text(v) : `${text(v)} (${n})`);
    }));
  }

  function syncFilters() {
    const items = state.data.items;
    const tally = (fn) => (v) => items.filter((i) => fn(i, v)).length;
    fillSelect("fPillar", pillars().map((p) => p.id), "All pillars", state.f.pillar, pillarLabel, tally((i, v) => i.pillar === v));
    fillSelect("fOwner", owners(), "All owners", state.f.owner, undefined, tally((i, v) => i.owner === v));
    fillSelect("fStatus", RAG, "All statuses", state.f.status, undefined, tally((i, v) => i.status === v));
    fillSelect("fRegion", uniq(items.flatMap((i) => regionTokens(i.region))), "All regions", state.f.region, undefined, tally((i, v) => regionTokens(i.region).includes(v)));
    fillSelect("fArea", uniq(items.map((i) => i.area)), "All areas", state.f.area, undefined, tally((i, v) => i.area === v));
    $("search").value = state.f.q;
    $("fPriority").checked = state.f.priority;
    $("fThisWeek").checked = state.f.thisWeek;
    $("fOverdue").checked = state.f.overdue;
    $("fAttention").checked = state.f.attention;
  }

  async function refresh() {
    state.data = await fetchJson(state.exec ? "/api/data?exec=1" : "/api/data");
    state.history = await fetchJson("/api/history");
    $("title").textContent = state.data.team.name;
    $("meta").textContent = `Lead: ${state.data.team.lead} · ${state.data.items.length} items · ${pillars().length} pillars`;
    syncFilters();
    render();
  }

  function askText(title, label, type, submit) {
    return new Promise((resolve) => {
      const input = el("input", { type, autocomplete: "off", maxlength: "60" });
      let value = null;
      const form = el("form", {}, el("h3", {}, title), el("label", {}, label, input),
        el("div", { class: "btns" }, el("button", { type: "button", class: "btn ghost", onclick: () => dlg.close() }, "Cancel"), el("button", { class: "btn" }, submit)));
      form.addEventListener("submit", (e) => { e.preventDefault(); value = input.value.trim(); dlg.close(); });
      dlg.addEventListener("close", () => resolve(value || null), { once: true });
      openDlg(form);
    });
  }

  const checkAuth = async () => (await fetch("/api/auth", { headers: { "X-Edit-Key": state.key } })).json();

  function setEditMode(on) {
    state.editMode = on;
    document.body.classList.toggle("edit-mode", on);
    $("editBtn").textContent = on ? "\u2713 Done editing" : "\u270E Edit";
    $("editBtn").classList.toggle("on", on);
    $("editBanner").hidden = !on;
  }

  async function ensureEdit() {
    if (state.canEdit) return true;
    let auth = await checkAuth();
    if (auth.user) {
      if (!auth.canEdit) { alert("Your account can view but not edit."); return false; }
      state.canEdit = true;
      state.canJordan = !!auth.canJordan;
      syncJordanTab();
      return true;
    }
    if (!auth.canEdit && auth.keyRequired) {
      const key = await askText("Enter edit key", "Edit key", "password", "Unlock");
      if (key == null) return false;
      state.key = key;
      auth = await checkAuth();
      if (!auth.canEdit) { alert("Incorrect edit key."); return false; }
      sessionStorage.setItem("editKey", key);
    }
    if (!auth.canEdit) { alert("Editing is only available on the machine running the server, or when an EDIT_KEY is configured."); return false; }
    if (!editorName()) {
      const name = await askText("Your name", "Shown in the activity log next to your changes", "text", "Continue");
      if (name == null) return false;
      localStorage.setItem("editorName", name);
    }
    state.canEdit = true;
    state.canJordan = !!auth.canJordan;
    syncJordanTab();
    return true;
  }

  async function toggleEdit() {
    if (state.editMode) setEditMode(false);
    else if (await ensureEdit()) setEditMode(true);
  }

  async function setExec(on) {
    state.exec = on;
    if (on) { state.f = { ...EMPTY_FILTERS }; setEditMode(false); }
    document.body.classList.toggle("exec", on);
    $("execBtn").textContent = on ? "Full view" : "Executive view";
    syncHash();
    await refresh();
  }

  function setView(v) {
    if (v === "wins") v = "milestones";
    // Each visit to Pillars starts with every pillar folded and every item group open.
    if (v === "pillars" && state.view !== "pillars") {
      openPillars.clear();
      closedAreas.clear();
      if (state.f.pillar) openPillars.add(state.f.pillar);
      savePillars();
      saveAreas();
    }
    state.view = v;
    [...$("tabs").children].forEach((b) => b.classList.toggle("active", b.dataset.view === tabFor(v)));
    syncHash();
    render();
  }

  $("tabs").addEventListener("click", (e) => {
    if (e.target.dataset.view) setView(e.target.dataset.view);
  });
  $("search").addEventListener("input", (e) => { state.f.q = e.target.value; syncHash(true); render(); });
  $("fPriority").addEventListener("change", (e) => { state.f.priority = e.target.checked; syncHash(); render(); });
  $("fThisWeek").addEventListener("change", (e) => { state.f.thisWeek = e.target.checked; syncHash(); render(); });
  $("fOverdue").addEventListener("change", (e) => { state.f.overdue = e.target.checked; syncHash(); render(); });
  $("fAttention").addEventListener("change", (e) => { state.f.attention = e.target.checked; syncHash(); render(); });
  [["fPillar", "pillar"], ["fOwner", "owner"], ["fStatus", "status"], ["fRegion", "region"], ["fArea", "area"]]
    .forEach(([id, key]) => $(id).addEventListener("change", (e) => { state.f[key] = e.target.value; syncHash(); render(); }));
  $("fClear").addEventListener("click", () => { state.f = { ...EMPTY_FILTERS }; syncFilters(); syncHash(); render(); });
  $("execBtn").addEventListener("click", () => setExec(!state.exec));
  $("editBtn").addEventListener("click", toggleEdit);
  $("fToggle").addEventListener("click", () => {
    const panel = $("fPanel");
    panel.hidden = !panel.hidden;
    $("fToggle").setAttribute("aria-expanded", String(!panel.hidden));
  });
  $("printBtn").addEventListener("click", () => window.print());

  document.body.classList.toggle("exec", state.exec);
  $("execBtn").textContent = state.exec ? "Full view" : "Executive view";
  function applyAuth(a) {
    if (a.authRequired && !a.user) { location.replace("/login"); return; }
    state.auth = a;
    state.canEdit = !!a.canEdit;
    state.canJordan = !!a.canJordan;
    $("whoami").textContent = a.user ? `${a.user} (${a.role})` : "";
    $("whoami").hidden = !a.user;
    $("logoutBtn").hidden = !a.user;
    $("signinLink").hidden = !(a.accounts && !a.user);
    if (a.user) { $("editBtn").hidden = !a.canEdit; $("activityBtn").hidden = !a.canEdit; }
    syncJordanTab();
    if (state.data && state.view === "jordan") render();
  }
  $("logoutBtn").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.replace("/login"); });
  checkAuth().then(applyAuth);
  const landing = readHash();
  if (landing && !landing.exec) {
    state.view = landing.view;
    state.f = landing.f;
    [...$("tabs").children].forEach((b) => b.classList.toggle("active", b.dataset.view === tabFor(state.view)));
  }
  window.addEventListener("popstate", applyHash);
  refresh().catch((e) => $("view").replaceChildren(el("div", { class: "empty" }, "Could not load data: " + e.message)));
})();
