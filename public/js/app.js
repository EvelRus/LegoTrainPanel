if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});

/* ── TOOLTIP ────────────────────────────────────────────────────── */
const tooltipEl = document.getElementById("tooltip");
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) { tooltipEl.style.display = "none"; return; }
  tooltipEl.textContent = el.dataset.tip;
  tooltipEl.style.display = "block";
});
document.addEventListener("mousemove", (e) => {
  let x = e.clientX + 14, y = e.clientY - 38;
  if (x + tooltipEl.offsetWidth > window.innerWidth - 8) x = e.clientX - tooltipEl.offsetWidth - 14;
  if (y < 8) y = e.clientY + 14;
  tooltipEl.style.left = x + "px";
  tooltipEl.style.top  = y + "px";
});
document.addEventListener("mouseout", (e) => {
  if (!e.target.closest("[data-tip]")) tooltipEl.style.display = "none";
});

/* ── SPEEDOMETER ────────────────────────────────────────────────── */
const S = { CX: 90, CY: 80, R: 72 };
function polarSpd(a, r) {
  const rad = (a * Math.PI) / 180;
  return { x: S.CX + r * Math.sin(rad), y: S.CY - r * Math.cos(rad) };
}
function f(n) { return n.toFixed(2); }
function buildSpeedo(id) {
  let ticks = "", lbls = "";
  for (let a = -90; a <= 90; a += 18) {
    const i = polarSpd(a, S.R - 6), o = polarSpd(a, S.R + 2);
    ticks += `<line x1="${f(i.x)}" y1="${f(i.y)}" x2="${f(o.x)}" y2="${f(o.y)}" stroke="#2a2d38" stroke-width="1.5"/>`;
  }
  [[-90,"−100"],[-45,"−50"],[0,"0"],[45,"+50"],[90,"+100"]].forEach(([a, t]) => {
    const p = polarSpd(a, S.R + 13), anc = a < -20 ? "start" : a > 20 ? "end" : "middle";
    lbls += `<text x="${f(p.x)}" y="${f(p.y)}" text-anchor="${anc}" fill="#3a3e4e" font-family="'Share Tech Mono',monospace" font-size="7">${t}</text>`;
  });
  return `<svg class="speedo-svg" viewBox="0 0 180 90" id="speedo-${id}"><defs><linearGradient id="sg${id}" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#40c4ff"/><stop offset="50%" stop-color="#00e676"/><stop offset="75%" stop-color="#ffd500"/><stop offset="100%" stop-color="#ff3b3b"/></linearGradient></defs><path d="M 18,80 A 72,72 0 1,1 162,80" fill="none" stroke="#252830" stroke-width="9" stroke-linecap="round"/><path d="M 18,80 A 72,72 0 1,1 162,80" fill="none" stroke="url(#sg${id})" stroke-width="9" stroke-linecap="round" opacity=".24"/>${ticks}${lbls}<path id="sarc-${id}" fill="none" stroke-width="9" stroke-linecap="round" opacity=".88"/><line id="sneedle-${id}" x1="${S.CX}" y1="${S.CY}" x2="${S.CX}" y2="${S.CY - S.R + 5}" stroke="#fff" stroke-width="2.2" stroke-linecap="round" style="transform-origin:${S.CX}px ${S.CY}px;transform:rotate(0deg);transition:transform .28s cubic-bezier(.25,.8,.25,1)"/><circle cx="${S.CX}" cy="${S.CY}" r="4.5" fill="#fff" opacity=".88"/><circle cx="${S.CX}" cy="${S.CY}" r="2" fill="#0d0d0f"/></svg>`;
}
function updateSpeedo(id, speed) {
  const needle = document.getElementById(`sneedle-${id}`), arcEl = document.getElementById(`sarc-${id}`);
  if (!needle) return;
  const ang = (speed / 100) * 90;
  needle.style.transform = `rotate(${ang}deg)`;
  const abs   = Math.abs(speed);
  const color = speed < 0 ? "#40c4ff" : abs < 40 ? "#00e676" : abs < 70 ? "#ffd500" : "#ff3b3b";
  needle.setAttribute("stroke", color);
  if (speed === 0) { arcEl.setAttribute("d", ""); return; }
  const tipR = S.R - 4, aRad = (ang * Math.PI) / 180;
  const tipX = f(S.CX + tipR * Math.sin(aRad)), tipY = f(S.CY - tipR * Math.cos(aRad));
  const sweep = speed > 0 ? 1 : 0;
  arcEl.setAttribute("d", `M ${f(S.CX)},${f(S.CY - tipR)} A ${tipR},${tipR} 0 0,${sweep} ${tipX},${tipY}`);
  arcEl.setAttribute("stroke", color);
}

/* ── SOCKET ─────────────────────────────────────────────────────── */
const socket = io({ transports: ["polling", "websocket"] });
const $ = (id) => document.getElementById(id);
let trainIds = new Set(), globalMuted = false, trainSounds = {}, prevSpeed = {}, currentConfig = {};
let editingUuid = null, previewAudio = null, previewFieldId = null;
let consists = {}, scenarios = {}, schedules = {}, isRecording = false;
function esc(s) { return String(s).replace(/'/g, "\\'"); }

/* ── PORT BADGES ────────────────────────────────────────────────── */
const PORT_ICONS = { motor: "⚙", sensor: "📡" };
const PORT_SHORT = {
  TrainMotorLarge: "TrnMtr", TrainMotor: "TrnMtr", TrainMotorSmall: "TrnSml",
  MediumMotor: "MedMtr", LargeMotor: "LrgMtr", XLargeMotor: "XLMtr",
  TechnicLargeMotor: "TechMtr", TechnicXLargeMotor: "TechXL",
  ColorDistanceSensor: "Clr+Dst", ColorSensor: "Clr", DistanceSensor: "Dst",
  TechnicColorSensor: "TColr", TechnicDistanceSensor: "TDst",
};
function updatePortBadges(id, ports) {
  const el = $(`portbadges-${id}`);
  if (!el || !ports) return;
  const badges = Object.entries(ports)
    .filter(([, info]) => info !== null)
    .map(([port, info]) => {
      const ico = PORT_ICONS[info.type] || "?";
      const short = PORT_SHORT[info.name] || info.name.slice(0, 6);
      const cls = info.type === "motor" ? "motor" : "sensor";
      return `<div class="port-badge ${cls}" data-tip="${port}: ${info.name}">${ico} ${port}·${short}</div>`;
    });
  el.innerHTML = badges.join("");
}

/* ── SOCKET EVENTS ──────────────────────────────────────────────── */
socket.on("connect", () => {
  $("statusPill").className = "pill conn";
  $("statusText").textContent = "Сервер";
  fetch("/api/config").then((r) => r.json()).then((c) => { currentConfig = c; });
  fetch("/api/info").then((r) => r.json()).then((v) => {
    const pu = $("puVer"), si = $("sioVer");
    if (pu) pu.textContent = `v${v.poweredUp}`;
    if (si) si.textContent = `v${v.socketIO}`;
  }).catch(() => {});
});
socket.on("connect_error", () => {
  $("statusPill").className = "pill err";
  $("statusText").textContent = "Ошибка";
});
socket.on("disconnect", () => {
  $("statusPill").className = "pill";
  $("statusText").textContent = "Отключено";
});
socket.on("log",  addLogEntry);
socket.on("logs", (entries) => {
  $("logList").innerHTML = "";
  entries.forEach(addLogEntry);
  scrollLog();
});
socket.on("consistsUpdate",  (d) => { consists  = d; renderConsistList(); renderSchActionParams(); trainIds.forEach((id) => renderConsistBadge(id)); });
socket.on("scenariosUpdate", (d) => { scenarios = d; renderScenarioList(); renderSchActionParams(); });
socket.on("schedulesUpdate", (d) => { schedules = d; renderScheduleList(); });
socket.on("scenarioRecording", ({ active, name }) => {
  isRecording = active;
  const badge = $("recBadge"), btn = $("recBtn");
  if (badge) badge.className = "rec-badge" + (active ? " on" : "");
  if (btn) {
    btn.textContent = active ? "■ Стоп" : "⬤ Запись";
    btn.className = "sm-btn sm-btn-red" + (active ? " active" : "");
  }
});
socket.on("scenarioPlayback", ({ name, active }) => {
  const btn = $(`sc-play-${name.replace(/[\s\W]/g, "_")}`);
  if (btn) {
    btn.textContent = active ? "■" : "▶";
    btn.className = `sm-btn ${active ? "sm-btn-red" : "sm-btn-grn"}`;
  }
});
socket.on("newTrain",     (d) => { addTrainCard(d); updatePortBadges(d.id, d.ports); refreshMsTrainSelect(); });
socket.on("trainRemoved", ({ id }) => removeTrainCard(id));
socket.on("speedUpdate",  ({ trainId, speed }) => {
  handleSpeedChange(trainId, speed);
  updateDisplay(trainId, speed);
  updateSpeedo(trainId, speed);
  updateEstopPulse();
});
socket.on("hubStatus", ({ id, battery, connected, reconnecting, lowBattery }) => {
  if (battery !== undefined)  updateBattery(id, battery, lowBattery);
  if (connected !== undefined) setConnected(id, connected);
  if (reconnecting) {
    const rc = $(`rc-${id}`);
    if (rc) { rc.classList.add("trying"); rc.textContent = "⟳ Поиск..."; }
  }
});
socket.on("sensorUpdate", ({ trainId, type, color, colorName, distance }) => {
  const el = $(`sensor-${trainId}`);
  if (!el) return;
  el.style.display = "";
  const SENSOR_COLORS = {
    0:"#111111",1:"#ff69b4",2:"#9b59b6",3:"#2980b9",4:"#00bcd4",
    5:"#1abc9c",6:"#27ae60",7:"#f1c40f",8:"#e67e22",9:"#e74c3c",10:"#ecf0f1",
  };
  if (type === "color" || type === "colorAndDistance") {
    const dot = $(`scolor-${trainId}`), lbl = $(`scolorname-${trainId}`);
    const css = SENSOR_COLORS[color];
    if (dot) { dot.style.background = css ?? "var(--bdr)"; dot.style.boxShadow = css ? `0 0 6px ${css}88` : "none"; }
    if (lbl) lbl.textContent = colorName ?? "?";
  }
  if (type === "distance" || type === "colorAndDistance") {
    const ds = $(`sdist-${trainId}`);
    if (ds) ds.textContent = distance != null ? `${distance} mm` : "—";
  }
});
socket.on("playHorn", ({ trainId }) => playOnce(trainId, "horn"));

/* ── TRAIN CARD ──────────────────────────────────────────────────── */
function addTrainCard(d) {
  const {
    id, name, speed = 0, sounds = {}, photo = null, connected = true,
    battery = null, firmwareVersion = "—", hardwareVersion = "—",
    hubTypeName = "—", deviceTypeName = "—", motorPort = "?",
    sensors = {}, rampStepSize = 10, rampStepMs = 100, presets = [20, 50, 80],
  } = d;

  const firstSensor     = Object.entries(sensors)[0];
  const sensorPort      = firstSensor?.[0] || null;
  const sensorTypeName  = firstSensor?.[1]?.typeName || null;

  if ($(`card-${id}`)) { setConnected(id, true); return; }

  trainIds.add(id);
  prevSpeed[id] = speed;

  $("emptyState").style.display = "none";
  initSounds(id, sounds);

  const batHtml = battery !== null
    ? `<div class="bat-badge ${batCls(battery)}" id="bat-${id}" data-tip="Батарея: ${battery}%">${batIco(battery)} ${battery}%</div>`
    : `<div id="bat-${id}" style="display:none"></div>`;

  const infoTip = `🔧 Прошивка: ${firmwareVersion}\n⚙ Железо: ${hardwareVersion}\n📡 Хаб: ${hubTypeName}\n🔌 ${motorPort}: ${deviceTypeName}${sensorPort ? `\n📡 ${sensorPort}: ${sensorTypeName}` : ""}`;

  const presetsHtml = presets
    .map((v) => `<button class="btn btn-preset" onclick="setSpeed('${esc(id)}',${v})">⚡${v}%</button>`)
    .join("");

  const sensorHtml = sensorPort
    ? `<div class="sensor-row" id="sensor-${id}" style="display:none">` +
      `<span class="s-label">📡 ${sensorPort}</span>` +
      `<div class="sensor-color-dot" id="scolor-${id}"></div>` +
      `<span id="scolorname-${id}" style="font-size:.7rem;color:var(--mut);min-width:48px">—</span>` +
      `<span id="sdist-${id}">—</span></div>`
    : "";

  const card = document.createElement("div");
  card.className = "train-card" + (connected ? "" : " disconnected");
  card.id = `card-${id}`;

  /* ── ИЗМЕНЕНИЯ UI:
     - Кнопки ±10 → ±20 (ниже мин. мощности 15% не работало ±10 надёжно)
     - Переименованы: "СТАРТ 20%" → "▶ ХОД (20%)", "ФИНИШ" → "■ ПЛАВНЫЙ СТОП"
     - Звуки перенесены выше спидометра (между фото и спидометром)
     - Добавлена подсказка что минимум 15%
  ── */
  card.innerHTML = `
    <div class="dc-overlay"><p>⚠ НЕТ СВЯЗИ</p><button class="btn-reconnect" id="rc-${id}" onclick="requestReconnect('${esc(id)}')">⟳ ПЕРЕПОДКЛЮЧИТЬ</button></div>
    <div class="card-inner">
      <div class="card-header">
        <div class="hdr-left">
          <div class="train-name">${name}</div>
          <div class="meta-row">
            ${batHtml}
            <div class="info-icon" data-tip="${infoTip}">🔧</div>
            <div class="port-badges" id="portbadges-${id}"></div>
            <div class="consist-badge" id="cbadge-${id}" style="display:none">состав</div>
          </div>
        </div>
        <div class="hdr-btns">
          <div class="icon-btn settings" onclick="openModal('${esc(id)}')" data-tip="Настройки поезда">🚃</div>
        </div>
      </div>

      <div class="photo-area${photo ? " has-photo" : ""}" id="photo-${id}">${photo ? `<img src="${photo}" alt="">` : ""}</div>

      <!-- Звуки — между фото и спидометром (по просьбе пользователя) -->
      <div class="sound-row">
        <button class="btn-snd${sounds.start ? "" : " na"}" onclick="playOnce('${esc(id)}','start')" data-tip="Звук старта"><span class="ico">🚀</span><span class="snd-lbl">СТАРТ</span></button>
        <button class="btn-snd${sounds.horn  ? "" : " na"}" id="horn-${id}" onmousedown="hornOn('${esc(id)}')" onmouseup="hornOff('${esc(id)}')" ontouchstart="hornOn('${esc(id)}')" ontouchend="hornOff('${esc(id)}')" data-tip="Гудок (удерж.)"><span class="ico">📯</span><span class="snd-lbl">ГУДОК</span></button>
        <button class="btn-snd${sounds.stop  ? "" : " na"}" onclick="playOnce('${esc(id)}','stop')"  data-tip="Звук торможения"><span class="ico">🛑</span><span class="snd-lbl">ТОРМОЗ</span></button>
      </div>

      <div class="card-body">
        <div class="speed-row">
          <div><div class="speed-num stop" id="speed-${id}">0</div><div class="speed-unit">% POWER</div></div>
          <div class="dir-badge" id="dir-${id}"><div class="arr">⏹</div><div>СТОП</div></div>
        </div>
        ${sensorHtml}
        <div class="speedo-wrap">${buildSpeedo(id)}</div>
        <div class="slider-wrap">
          <div class="slider-labels"><span>← −100</span><span>+100 →</span></div>
          <div style="position:relative">
            <input type="range" min="-100" max="100" value="${speed}" step="5" id="slider-${id}">
            <div class="center-mark"></div>
          </div>
        </div>
        <div class="actions">
          <div class="speed-btns">
            <button class="btn" onclick="setSpeed('${esc(id)}',-100)" data-tip="Полный назад">◀◀ −100</button>
            <button class="btn" onclick="deltaSpeed('${esc(id)}',-20)" data-tip="−20%">−20</button>
            <button class="btn btn-stop-c" onclick="setSpeed('${esc(id)}',0)" data-tip="Мгновенный стоп">■ СТОП</button>
            <button class="btn" onclick="deltaSpeed('${esc(id)}',20)" data-tip="+20%">+20</button>
            <button class="btn" onclick="setSpeed('${esc(id)}',100)" data-tip="Полный вперёд">+100 ▶▶</button>
          </div>
          <div class="start-stop-row">
            <button class="btn btn-go"   onclick="doStart('${esc(id)}')" data-tip="Плавный старт с 20%">▶ ХОД (20%)</button>
            <button class="btn btn-halt" onclick="doStop('${esc(id)}')"  data-tip="Плавная остановка через рамп">■ ПЛАВНЫЙ СТОП</button>
          </div>
          <div class="preset-row" id="presets-${id}">${presetsHtml}</div>
        </div>
      </div>
    </div>`;

  $("trainsContainer").appendChild(card);
  if (speed !== 0) updateDisplay(id, speed);
  updateSpeedo(id, speed);

  const sl = $(`slider-${id}`);
  let deb, lastEmitted = speed;
  sl.addEventListener("input", () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      const v = +sl.value;
      if (v === lastEmitted) return;
      lastEmitted = v;
      socket.emit("setSpeed", { trainId: id, speed: v });
    }, 120);
  });
  sl.addEventListener("change", () => {
    const v = +sl.value;
    if (Math.abs(v) <= 8 && lastEmitted !== 0) {
      sl.value = 0; lastEmitted = 0;
      socket.emit("setSpeed", { trainId: id, speed: 0 });
    }
  });

  renderConsistBadge(id);
}

function removeTrainCard(id) {
  stopLoop(id);
  trainIds.delete(id);
  delete trainSounds[id];
  delete prevSpeed[id];
  const card = $(`card-${id}`);
  if (card) {
    card.style.transition = "all .4s";
    card.style.opacity = "0";
    card.style.transform = "scale(.95)";
    setTimeout(() => card.remove(), 400);
  }
  if (!trainIds.size) $("emptyState").style.display = "";
  updateEstopPulse();
  refreshMsTrainSelect();
}

/* ── SOUNDS ──────────────────────────────────────────────────────── */
function toggleMute() {
  globalMuted = !globalMuted;
  // FIX: используем id="muteIco" и id="muteLbl" которые есть в index.html
  const ico = $("muteIco"), lbl = $("muteLbl");
  if (ico) ico.textContent = globalMuted ? "🔇" : "🔊";
  if (lbl) lbl.textContent = globalMuted ? "ВЫКЛ" : "Звук";
  $("muteBtn").className = "pill" + (globalMuted ? " muted" : "");
  if (globalMuted) trainIds.forEach((id) => muteAllSounds(id));
}
function muteAllSounds(id) {
  const s = trainSounds[id];
  if (!s) return;
  Object.values(s).forEach((a) => { if (a) { a.pause(); a.currentTime = 0; } });
}
function mkAudio(src, loop = false) {
  if (!src) return null;
  const a = new Audio(src);
  a.loop = loop; a.preload = "auto";
  return a;
}
function initSounds(id, sounds) {
  trainSounds[id] = {
    start:  mkAudio(sounds.start),
    stop:   mkAudio(sounds.stop),
    horn:   mkAudio(sounds.horn),
    moving: mkAudio(sounds.moving, true),
  };
}
function reloadSounds(id, sounds) { stopLoop(id); initSounds(id, sounds); }
function playOnce(id, type) {
  if (globalMuted) return;
  const s = trainSounds[id];
  if (!s || !s[type]) return;
  s[type].currentTime = 0;
  s[type].play().catch(() => {});
}
const _loopPlayPromise = {};
function startLoop(id) {
  if (globalMuted || (prevSpeed[id] ?? 0) === 0) return;
  const s = trainSounds[id];
  if (!s?.moving) return;
  if (s.moving.paused) {
    s.moving.currentTime = 0;
    _loopPlayPromise[id] = s.moving.play().catch(() => {});
  }
}
function stopLoop(id) {
  const s = trainSounds[id];
  if (!s?.moving) return;
  const p = _loopPlayPromise[id];
  delete _loopPlayPromise[id];
  const stop = () => { s.moving.pause(); s.moving.currentTime = 0; };
  p ? p.then(stop).catch(stop) : stop();
}
function setLoopVol(id, speed) {
  const s = trainSounds[id];
  if (s?.moving) s.moving.volume = Math.min(1, Math.abs(speed) / 60);
}
const _startLoopTimer = {};
function handleSpeedChange(id, newSpeed) {
  const prev = prevSpeed[id] ?? 0;
  prevSpeed[id] = newSpeed;
  if (prev === 0 && newSpeed !== 0) {
    playOnce(id, "start");
    const s = trainSounds[id];
    const delay = s?.start && isFinite(s.start.duration) && s.start.duration > 0.1
      ? s.start.duration * 1000 : 900;
    clearTimeout(_startLoopTimer[id]);
    _startLoopTimer[id] = setTimeout(() => { startLoop(id); setLoopVol(id, prevSpeed[id]); }, delay);
  } else if (prev !== 0 && newSpeed === 0) {
    clearTimeout(_startLoopTimer[id]);
    delete _startLoopTimer[id];
    stopLoop(id);
    playOnce(id, "stop");
  } else if (prev !== 0 && newSpeed !== 0) {
    setLoopVol(id, newSpeed);
  }
}
function hornOn(id) {
  if (globalMuted) return;
  const s = trainSounds[id];
  if (!s?.horn) return;
  s.horn.currentTime = 0;
  s.horn.play().catch(() => {});
  $(`horn-${id}`)?.classList.add("on");
}
function hornOff(id) {
  const s = trainSounds[id];
  if (!s?.horn) return;
  s.horn.pause(); s.horn.currentTime = 0;
  $(`horn-${id}`)?.classList.remove("on");
}

/* ── CONTROLS ────────────────────────────────────────────────────── */
function setSpeed(id, speed)  { socket.emit("setSpeed", { trainId: id, speed }); }
function deltaSpeed(id, d)    { const sl = $(`slider-${id}`); setSpeed(id, Math.max(-100, Math.min(100, +sl.value + d))); }
function doStart(id)          { setSpeed(id, 20); }
// FIX: doStop вызывает setSpeed(0) → server.js → ramp.stopNow (через setSpeed handler)
// Это правильно: одна точка входа для всех команд скорости
function doStop(id)           { setSpeed(id, 0); }
function requestReconnect(id) { socket.emit("reconnectHub", { trainId: id }); }
function estop()              { socket.emit("estop"); }
function updateEstopPulse()   {
  const any = [...trainIds].some((id) => (prevSpeed[id] ?? 0) !== 0);
  $("estopBtn")?.classList.toggle("pulse", any);
}

function updateDisplay(id, speed) {
  const el = $(`speed-${id}`), sl = $(`slider-${id}`), dir = $(`dir-${id}`), card = $(`card-${id}`);
  if (!el) return;
  el.textContent = Math.abs(speed);
  sl.value = speed;
  if (speed > 0) {
    el.className = "speed-num";
    dir.className = "dir-badge fwd";
    dir.innerHTML = '<div class="arr">▶</div><div>ВПЕРЁД</div>';
    card.classList.add("active");
  } else if (speed < 0) {
    el.className = "speed-num rev";
    dir.className = "dir-badge rev";
    dir.innerHTML = '<div class="arr">◀</div><div>НАЗАД</div>';
    card.classList.add("active");
  } else {
    el.className = "speed-num stop";
    dir.className = "dir-badge";
    dir.innerHTML = '<div class="arr">⏹</div><div>СТОП</div>';
    card.classList.remove("active");
  }
}
function setConnected(id, ok) {
  const card = $(`card-${id}`);
  if (!card) return;
  card.classList.toggle("disconnected", !ok);
  const rc = $(`rc-${id}`);
  if (rc && ok) { rc.classList.remove("trying"); rc.textContent = "⟳ ПЕРЕПОДКЛЮЧИТЬ"; }
}
function batCls(l) { return l > 40 ? "hi" : l > 15 ? "mid" : "lo"; }
function batIco(l) { return l > 30 ? "🔋" : "🪫"; }
function updateBattery(id, lvl, low) {
  const el = $(`bat-${id}`);
  if (!el) return;
  el.style.display = "";
  el.className = `bat-badge ${batCls(lvl)}`;
  el.dataset.tip = `Батарея: ${lvl}%`;
  el.innerHTML = `${batIco(lvl)} ${lvl}%`;
}

/* ── LOG ──────────────────────────────────────────────────────────── */
let logOpen = false;
function toggleLog() {
  logOpen = !logOpen;
  $("logDrawer").classList.toggle("open", logOpen);
  $("logBtn").classList.toggle("active", logOpen);
  if (logOpen) scrollLog();
}
function scrollLog()    { const l = $("logList"); if (l) l.scrollTop = l.scrollHeight; }
function clearLogView() { $("logList").innerHTML = ""; }
function addLogEntry(entry) {
  const el = document.createElement("div");
  el.className = "log-entry";
  const ts = entry.ts.replace("T", " ").replace(/\.\d+Z$/, "");
  el.innerHTML = `<span class="log-ts">${ts}</span><span class="log-lvl lv-${entry.level}">${entry.level}</span><span class="log-msg">${entry.trainId ? `<b>${entry.trainId.slice(0, 8)}</b> ` : ""}${entry.message}</span>`;
  $("logList").appendChild(el);
  if (logOpen) scrollLog();
}

/* FIX: добавлены отсутствующие функции для работы с файлами логов */
async function loadLogFiles() {
  try {
    const files = await fetch("/api/logs/files").then((r) => r.json());
    const sel = $("logFileSelect");
    if (!sel) return;
    if (!files.length) { sel.style.display = "none"; return; }
    sel.innerHTML = files.map((f) => `<option value="${f}">${f}</option>`).join("");
    sel.style.display = "";
  } catch (e) {
    console.error("loadLogFiles:", e);
  }
}
async function loadLogFile() {
  const sel  = $("logFileSelect");
  const name = sel?.value;
  if (!name) return;
  try {
    const text = await fetch(`/api/logs/file?name=${encodeURIComponent(name)}`).then((r) => r.text());
    $("logList").innerHTML = "";
    text.split("\n").filter(Boolean).forEach((line) => {
      const el = document.createElement("div");
      el.className = "log-entry";
      // Пытаемся распарсить формат [ts] [level] [tid] msg
      const m = line.match(/^\[(.+?)\] \[(.+?)\](?:\s\[(.+?)\])? (.+)$/);
      if (m) {
        el.innerHTML = `<span class="log-ts">${m[1].replace("T", " ").replace(/\.\d+Z$/, "")}</span>`
          + `<span class="log-lvl lv-${m[2]}">${m[2]}</span>`
          + `<span class="log-msg">${m[3] ? `<b>${m[3].slice(0, 8)}</b> ` : ""}${m[4]}</span>`;
      } else {
        el.textContent = line;
      }
      $("logList").appendChild(el);
    });
    scrollLog();
  } catch (e) {
    console.error("loadLogFile:", e);
  }
}

/* ── AUTO MODAL ────────────────────────────────────────────────────── */
function openAutoModal(tab) {
  $("autoBackdrop").classList.add("open");
  setAutoTab(tab || "consists");
  renderConsistTrainList();
  renderConsistList();
  renderScenarioList();
  renderScheduleList();
  renderSchActionParams();
  refreshMsTrainSelect();
  renderManualSteps();
}
function closeAutoModal()         { $("autoBackdrop").classList.remove("open"); }
function closeAutoOuter(e)        { if (e.target === $("autoBackdrop")) closeAutoModal(); }

function setAutoTab(tab) {
  ["consists", "scenarios", "schedules"].forEach((t) => {
    $(`aTab-${t}`).className   = "auto-tab"   + (t === tab ? " active" : "");
    $(`aPanel-${t}`).className = "auto-panel" + (t === tab ? " active" : "");
  });
}
function setScTab(tab) {
  document.querySelectorAll(".sc-stab").forEach(
    (b) => (b.className = "sc-stab" + (b.dataset.tab === tab ? " active" : "")),
  );
  document.querySelectorAll(".sc-subpanel").forEach(
    (p) => (p.className = "sc-subpanel" + (p.id === `sc-${tab}` ? " active" : "")),
  );
}

/* ── CONSISTS ──────────────────────────────────────────────────────── */
function renderConsistTrainList() {
  const el = $("cTrainList");
  if (!el) return;
  el.innerHTML = [...trainIds].map((id) => {
    const n = $(`card-${id}`)?.querySelector(".train-name")?.textContent || id;
    return `<label class="train-check-item"><input type="checkbox" id="cc-${id}" value="${id}"> ${n}</label>`;
  }).join("") || '<div style="color:var(--mut);font-family:var(--fm);font-size:.7rem">Нет подключённых поездов</div>';
}
function createConsist() {
  const name = $("cName").value.trim();
  if (!name) return;
  const ids = [...$("cTrainList").querySelectorAll("input:checked")].map((c) => c.value);
  if (!ids.length) return;
  socket.emit("saveConsist", { id: `c${Date.now()}`, consist: { name, trainIds: ids, speed: 0 } });
  $("cName").value = "";
  $("cTrainList").querySelectorAll("input").forEach((i) => (i.checked = false));
}
function renderConsistList() {
  const el = $("consistList");
  if (!el) return;
  const entries = Object.entries(consists);
  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--mut);font-family:var(--fm);font-size:.7rem;padding:8px">Составов нет</div>';
    return;
  }
  el.innerHTML = entries.map(([id, c]) =>
    `<div class="consist-list-item">
      <div style="flex:1;min-width:0">
        <div class="cl-name">${c.name}</div>
        <div class="cl-trains">${(c.trainIds || []).map((t) => t.slice(0, 8)).join(", ")}</div>
      </div>
      <input type="range" min="-100" max="100" value="${c.speed || 0}" step="5" style="width:90px"
        oninput="consistSpeedDisplay('${id}',this.value)" onchange="setConsistSpeed('${id}',+this.value)">
      <span class="cl-spd" id="cspd-${id}">${c.speed || 0}%</span>
      <button class="sm-btn sm-btn-red" onclick="socket.emit('deleteConsist',{id:'${id}'})" data-tip="Удалить состав">🗑</button>
    </div>`
  ).join("");
}
function consistSpeedDisplay(id, v) { const el = $(`cspd-${id}`); if (el) el.textContent = `${v}%`; }
function setConsistSpeed(id, speed) { socket.emit("setConsistSpeed", { consistId: id, speed }); }
function renderConsistBadge(trainId) {
  const badge = $(`cbadge-${trainId}`);
  if (!badge) return;
  const inC = Object.values(consists).some((c) => (c.trainIds || []).includes(trainId));
  badge.style.display = inC ? "" : "none";
  $(`card-${trainId}`)?.classList.toggle("consist-member", inC);
}

/* ── MANUAL SCENARIO BUILDER ────────────────────────────────────────
   Структура шага: { trainId, trainName, speed, duration, condition }
   condition: null | { type:'colorSensor', port:'B', color:5 }
   ─────────────────────────────────────────────────────────────────── */
let manualSteps = [];

const COLOR_NAMES_RU = {
  0:"Чёрный",1:"Розовый",2:"Фиолетовый",3:"Синий",4:"Голубой",
  5:"Бирюзовый",6:"Зелёный",7:"Жёлтый",8:"Оранжевый",9:"Красный",10:"Белый",
};

function refreshMsTrainSelect() {
  const sel = $("msTrainId");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = [...trainIds].map((id) => {
    const n = $(`card-${id}`)?.querySelector(".train-name")?.textContent || id;
    return `<option value="${id}">${n}</option>`;
  }).join("") || '<option value="">Нет поездов</option>';
  if (prev) sel.value = prev;
}

function updateMsSpeed() {
  const v = +$("msSpeed").value;
  $("msSpeedVal").textContent = v;
  const dir = $("msSpeedDir");
  if (!dir) return;
  if (v > 0) {
    dir.textContent = `▶ Вперёд +${v}%`;
    dir.style.color = "var(--grn)";
    dir.style.borderColor = "rgba(0,230,118,0.35)";
  } else if (v < 0) {
    dir.textContent = `◀ Назад ${v}%`;
    dir.style.color = "var(--blu)";
    dir.style.borderColor = "rgba(64,196,255,0.35)";
  } else {
    dir.textContent = "■ Стоп";
    dir.style.color = "var(--red)";
    dir.style.borderColor = "rgba(255,59,59,0.35)";
  }
}

function updateMsCondition() {
  const type = $("msConditionType").value, params = $("msConditionParams");
  if (!params) return;
  if (type === "colorSensor") {
    const colorOpts = Object.entries(COLOR_NAMES_RU)
      .map(([v, n]) => `<option value="${v}">${n}</option>`).join("");
    params.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div>
          <div class="field-label">Порт сенсора</div>
          <select class="field-input" id="msCondPort">
            <option>A</option><option selected>B</option><option>C</option><option>D</option>
          </select>
        </div>
        <div>
          <div class="field-label">Цвет</div>
          <select class="field-input" id="msCondColor">${colorOpts}</select>
        </div>
      </div>
      <div style="font-family:var(--fm);font-size:.61rem;color:var(--mut);margin-top:4px">
        Шаг выполнится когда датчик зафиксирует этот цвет (вместо ожидания по времени).
        Длительность используется как таймаут — если цвет не пришёл, шаг выполнится по времени.
      </div>`;
    params.style.display = "";
  } else {
    params.innerHTML = "";
    params.style.display = "none";
  }
}

function addManualStep() {
  const trainSelect = $("msTrainId");
  if (!trainSelect || !trainSelect.value) return;
  const trainId   = trainSelect.value;
  const trainName = trainSelect.options[trainSelect.selectedIndex]?.text || trainId;
  const speed     = +$("msSpeed").value;
  const duration  = Math.max(0.1, +$("msDuration").value || 3);
  const condType  = $("msConditionType").value;
  let condition   = null;
  if (condType === "colorSensor") {
    condition = {
      type: "colorSensor",
      port:  $("msCondPort")?.value || "B",
      color: +($("msCondColor")?.value ?? 0),
    };
  }
  manualSteps.push({ trainId, trainName, speed, duration, condition });
  renderManualSteps();
}

function removeManualStep(i) { manualSteps.splice(i, 1); renderManualSteps(); }
function clearManualSteps()  { manualSteps = []; renderManualSteps(); }

function loadScenarioToBuilder(name) {
  const sc = scenarios[name];
  if (!sc?.steps?.length) return;
  manualSteps = sc.steps.map((step, i) => {
    const nextDelay = sc.steps[i + 1]?.delay ?? step.delay + 3000;
    const duration  = Math.max(0.1, Math.round((nextDelay - step.delay) / 100) / 10);
    const trainName = document.querySelector(`#card-${step.trainId} .train-name`)?.textContent || step.trainId;
    return { trainId: step.trainId, trainName, speed: step.speed ?? 0, duration, condition: step.condition || null };
  });
  const nameEl = $("msScName");
  if (nameEl) nameEl.value = name;
  setAutoTab("scenarios");
  setScTab("manual");
  renderManualSteps();
  $("sc-manual")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function moveManualStep(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= manualSteps.length) return;
  [manualSteps[i], manualSteps[j]] = [manualSteps[j], manualSteps[i]];
  renderManualSteps();
}

function editManualStep(i) {
  const step = manualSteps[i];
  if (!step) return;
  const el = $(`ms-step-${i}`);
  if (!el) return;
  const trainOpts = [...trainIds]
    .map((id) => {
      const n = document.querySelector(`#card-${id} .train-name`)?.textContent || id;
      return `<option value="${id}" ${id === step.trainId ? "selected" : ""}>${n}</option>`;
    }).join("") || `<option value="${step.trainId}" selected>${step.trainName}</option>`;
  const v = step.speed;
  const dirText = v > 0 ? `▶ +${v}%` : v < 0 ? `◀ ${v}%` : "■ Стоп";
  const dirClr  = v > 0 ? "var(--grn)" : v < 0 ? "var(--blu)" : "var(--red)";
  el.innerHTML = `
    <div class="step-num">${i + 1}</div>
    <div class="step-info" style="flex:1;display:grid;gap:5px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;align-items:center">
        <select class="field-input" id="es-train-${i}">${trainOpts}</select>
        <span id="es-dir-${i}" style="font-family:var(--fm);font-size:.68rem;color:${dirClr};padding:2px 4px;border-radius:4px;background:var(--surf3)">${dirText}</span>
      </div>
      <input type="range" min="-100" max="100" step="5" value="${v}" id="es-speed-${i}"
        oninput="(function(val){const d=$('es-dir-${i}');d.textContent=val>0?'▶ +'+val+'%':val<0?'◀ '+val+'%':'■ Стоп';d.style.color=val>0?'var(--grn)':val<0?'var(--blu)':'var(--red)';})(+this.value)" />
      <div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:5px;align-items:center">
        <span style="font-family:var(--fm);font-size:.62rem;color:var(--mut)">сек:</span>
        <input type="number" class="field-input" id="es-dur-${i}" min="0.1" max="3600" step="0.5" value="${step.duration}" style="padding:2px 5px" />
        <button class="sm-btn sm-btn-grn" onclick="applyStepEdit(${i})">✓ Ок</button>
        <button class="sm-btn sm-btn-mut" onclick="renderManualSteps()">✕</button>
      </div>
    </div>`;
}

function applyStepEdit(i) {
  const step = manualSteps[i];
  if (!step) return;
  const trainSel = $(`es-train-${i}`);
  step.trainId   = trainSel?.value || step.trainId;
  step.trainName = trainSel?.options[trainSel.selectedIndex]?.text || step.trainId;
  step.speed     = +($(`es-speed-${i}`)?.value ?? step.speed);
  step.duration  = Math.max(0.1, +($(`es-dur-${i}`)?.value ?? step.duration));
  renderManualSteps();
}

function renderManualSteps() {
  const el = $("msStepsList");
  if (!el) return;
  if (!manualSteps.length) {
    el.innerHTML = '<div style="color:var(--mut);font-family:var(--fm);font-size:.7rem;padding:6px 0">Шагов нет — настройте параметры и нажмите «Добавить шаг»</div>';
    return;
  }
  const totalSec = manualSteps.reduce((s, step) => s + step.duration, 0);
  let cumSec = 0;
  el.innerHTML = manualSteps.map((step, i) => {
    const at = cumSec.toFixed(1);
    cumSec += step.duration;
    const speedCls = step.speed > 0 ? "step-speed" : step.speed < 0 ? "step-speed rev" : "step-speed stop-clr";
    const speedLbl = step.speed === 0 ? "■ СТОП" : step.speed > 0 ? `▶ +${step.speed}%` : `◀ ${step.speed}%`;
    const condHtml = step.condition
      ? `<div class="step-cond">⚡ ждём: цвет сенсора ${step.condition.port} = ${COLOR_NAMES_RU[step.condition.color] ?? step.condition.color} (таймаут ${step.duration}с)</div>`
      : "";
    return `<div class="step-card" id="ms-step-${i}">
      <div class="step-num">${i + 1}</div>
      <div class="step-info">
        <span class="step-train">${step.trainName}</span><span style="color:var(--mut)"> → </span>
        <span class="${speedCls}">${speedLbl}</span>
        <span class="step-dur"> · ${step.duration}с (t+${at}с)</span>
        ${condHtml}
      </div>
      <div style="display:flex;gap:3px;flex-shrink:0">
        <button class="step-move-btn" ${i === 0 ? "disabled" : ""} onclick="moveManualStep(${i},-1)" title="Вверх">↑</button>
        <button class="step-move-btn" ${i === manualSteps.length - 1 ? "disabled" : ""} onclick="moveManualStep(${i},1)" title="Вниз">↓</button>
        <button class="sm-btn sm-btn-blu" style="padding:2px 6px" onclick="editManualStep(${i})" title="Редактировать">✎</button>
        <button class="sm-btn sm-btn-red" style="padding:2px 6px" onclick="removeManualStep(${i})" title="Удалить">✕</button>
      </div>
    </div>`;
  }).join("") +
    `<div style="font-family:var(--fm);font-size:.63rem;color:var(--mut);padding-top:5px;border-top:1px solid var(--bdr);margin-top:4px">
      Итого: ${totalSec.toFixed(1)} сек · ${manualSteps.length} шагов
    </div>`;
}

function saveManualScenario() {
  const name = $("msScName").value.trim();
  if (!name) {
    $("msScName").style.borderColor = "var(--red)";
    setTimeout(() => ($("msScName").style.borderColor = ""), 1000);
    return;
  }
  if (!manualSteps.length) return;
  let cumDelay = 0;
  const steps = [];
  for (const step of manualSteps) {
    steps.push({ trainId: step.trainId, speed: step.speed, delay: cumDelay, condition: step.condition || null });
    cumDelay += Math.round(step.duration * 1000);
  }
  socket.emit("saveScenario", { name, data: { steps, created: new Date().toISOString(), source: "manual" } });
  $("msScName").value = "";
  clearManualSteps();
}

/* ── RECORDING ────────────────────────────────────────────────────── */
function toggleRecording() {
  if (!isRecording) {
    const name = $("scName").value.trim();
    if (!name) {
      $("scName").style.borderColor = "var(--red)";
      setTimeout(() => ($("scName").style.borderColor = ""), 1000);
      return;
    }
    socket.emit("startRecording", { name });
  } else {
    socket.emit("stopRecording");
  }
}

function renderScenarioList() {
  const el = $("scenarioList");
  if (!el) return;
  const entries = Object.entries(scenarios);
  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--mut);font-family:var(--fm);font-size:.7rem;padding:8px">Сценариев нет</div>';
    return;
  }
  el.innerHTML = entries.map(([name, sc]) => {
    const safeId   = name.replace(/[\s\W]/g, "_");
    const srcIcon  = sc.source === "manual" ? "✏️" : "⬤";
    const loops    = sc.loops ?? 1;
    const loopLabel = loops === 0 ? "∞" : `×${loops}`;
    return `<div class="scenario-item">
      <div style="flex:1">
        <div class="sc-name">${srcIcon} ${name}</div>
        <div class="sc-meta" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span>${sc.steps?.length || 0} шагов · ${(sc.created || "").slice(0, 10)}</span>
          <span style="display:flex;align-items:center;gap:4px">
            <span style="color:var(--mut)">повтор:</span>
            <button class="loop-adj" onclick="adjLoops('${esc(name)}',-1)">−</button>
            <span class="loop-val" id="sc-loops-${safeId}">${loopLabel}</span>
            <button class="loop-adj" onclick="adjLoops('${esc(name)}',1)">+</button>
          </span>
        </div>
      </div>
      <div class="sc-actions" style="display:flex;gap:4px;flex-shrink:0">
        <button class="sm-btn sm-btn-grn" id="sc-play-${safeId}" onclick="playScenario('${esc(name)}')" data-tip="Запустить / остановить">▶</button>
        <button class="sm-btn sm-btn-blu" onclick="loadScenarioToBuilder('${esc(name)}')" data-tip="Редактировать в построителе">✎</button>
        <button class="sm-btn sm-btn-red" onclick="socket.emit('deleteScenario',{name:'${esc(name)}'})" data-tip="Удалить сценарий">🗑</button>
      </div>
    </div>`;
  }).join("");
}

function playScenario(name) {
  const btn = $(`sc-play-${name.replace(/[\s\W]/g, "_")}`);
  if (btn?.textContent === "■") socket.emit("stopScenario", { name });
  else {
    const loops = scenarios[name]?.loops ?? 1;
    socket.emit("playScenario", { name, loops });
  }
}

function adjLoops(name, delta) {
  const sc = scenarios[name];
  if (!sc) return;
  const cur  = sc.loops ?? 1;
  let   next;
  if (delta > 0) next = cur === 0 ? 1 : Math.min(cur + 1, 9);
  else           next = cur <= 1  ? 0 : cur - 1;
  sc.loops = next;
  socket.emit("saveScenario", { name, data: { ...sc, loops: next } });
  const valEl = $(`sc-loops-${name.replace(/[\s\W]/g, "_")}`);
  if (valEl) valEl.textContent = next === 0 ? "∞" : `×${next}`;
}

/* ── SCHEDULES ────────────────────────────────────────────────────── */
function renderSchActionParams() {
  const type = $("schActionType")?.value, el = $("schActionParams");
  if (!el) return;
  if (type === "setSpeed") {
    const opts = [...trainIds].map((id) => {
      const n = $(`card-${id}`)?.querySelector(".train-name")?.textContent || id;
      return `<option value="${id}">${n}</option>`;
    }).join("");
    el.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><div class="field-label">Поезд</div><select class="field-input" id="schTrain">${opts || "<option>—</option>"}</select></div><div><div class="field-label">Скорость %</div><input class="field-input" id="schSpeed" type="number" min="-100" max="100" value="50"></div></div>`;
  } else if (type === "playScenario") {
    const opts = Object.keys(scenarios).map((n) => `<option value="${n}">${n}</option>`).join("");
    el.innerHTML = `<div><div class="field-label">Сценарий</div><select class="field-input" id="schScenario">${opts || "<option>—</option>"}</select></div>`;
  } else if (type === "setConsist") {
    const opts = Object.entries(consists).map(([id, c]) => `<option value="${id}">${c.name}</option>`).join("");
    el.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><div class="field-label">Состав</div><select class="field-input" id="schConsist">${opts || "<option>—</option>"}</select></div><div><div class="field-label">Скорость %</div><input class="field-input" id="schCSpeed" type="number" min="-100" max="100" value="50"></div></div>`;
  } else {
    el.innerHTML = "";
  }
}

function addSchedule() {
  const name = $("schName").value.trim();
  if (!name) return;
  const time = $("schTime").value;
  if (!time) return;
  const days = [...document.querySelectorAll(".day-btn.on")].map((b) => +b.dataset.d);
  const type = $("schActionType").value;
  let action = { type };
  if (type === "setSpeed")    { action.trainId = $("schTrain")?.value; action.speed = +($("schSpeed")?.value || 50); }
  if (type === "playScenario") { action.name   = $("schScenario")?.value; }
  if (type === "setConsist")  { action.consistId = $("schConsist")?.value; action.speed = +($("schCSpeed")?.value || 50); }
  socket.emit("addSchedule", { id: `s${Date.now()}`, schedule: { name, time, days, action } });
  $("schName").value = "";
  $("schTime").value = "";
  document.querySelectorAll(".day-btn.on").forEach((b) => b.classList.remove("on"));
}

const DAY_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
function renderScheduleList() {
  const el = $("scheduleList");
  if (!el) return;
  const entries = Object.entries(schedules);
  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--mut);font-family:var(--fm);font-size:.7rem;padding:8px">Задач нет</div>';
    return;
  }
  el.innerHTML = entries.map(([id, s]) => {
    const days = s.days?.length ? s.days.map((d) => DAY_NAMES[d]).join(",") : "каждый день";
    const act = s.action?.type === "estop"        ? "⛔ E-STOP"
      : s.action?.type === "setSpeed"             ? `→ ${(s.action.trainId || "").slice(0, 8)} ${s.action.speed}%`
      : s.action?.type === "playScenario"         ? `▶ ${s.action.name}`
      : s.action?.type === "setConsist"           ? `🔗 ${s.action.speed}%`
      : "—";
    return `<div class="sch-item">
      <span class="sch-time">${s.time}</span>
      <span class="sch-desc">${days} · <b>${s.name}</b> · ${act}</span>
      <button class="sm-btn sm-btn-red" onclick="socket.emit('removeSchedule',{id:'${id}'})" data-tip="Удалить задачу">🗑</button>
    </div>`;
  }).join("");
}

/* ── SETTINGS MODAL ────────────────────────────────────────────────── */
async function openModal(id) {
  editingUuid = id;
  const cfg     = await fetch("/api/config").then((r) => r.json());
  currentConfig = cfg;
  const entry   = currentConfig[id] || {}, sounds = entry.sounds || {}, presets = entry.presets || [20, 50, 80];
  $("modalTitle").textContent = `⚙ Настройки: ${entry.name || id.slice(0, 8)}`;
  $("mName").value    = entry.name   || "";
  $("mPhoto").value   = entry.photo  || "";
  $("mStart").value   = sounds.start || "";
  $("mStop").value    = sounds.stop  || "";
  $("mHorn").value    = sounds.horn  || "";
  $("mMoving").value  = sounds.moving || "";
  const step = entry.rampStepSize || 10, ms = entry.rampStepMs || 100;
  $("mRampStep").value = step;
  $("mRampMs").value   = ms;
  $("rStepVal").textContent = step;
  $("rMsVal").textContent   = ms;
  updateRampHint();
  $("mPre0").value = presets[0] ?? 20;
  $("mPre1").value = presets[1] ?? 50;
  $("mPre2").value = presets[2] ?? 80;
  document.querySelectorAll(".file-browser").forEach((fb) => fb.classList.remove("open"));
  $("photoPreviewImg").style.display = "none";
  stopPreviewAudio();
  const sb = $("saveBtn");
  sb.className  = "btn-save";
  sb.textContent = "💾 СОХРАНИТЬ";
  $("modalBackdrop").classList.add("open");
}
function updateRampHint() {
  const step = +$("mRampStep").value, ms = +$("mRampMs").value;
  $("rStepVal").textContent = step;
  $("rMsVal").textContent   = ms;
  $("rampHint").textContent = `Диапазон 200% за ~${(((200 / step) * ms) / 1000).toFixed(1)} с`;
}
function closeModal()           { $("modalBackdrop").classList.remove("open"); stopPreviewAudio(); }
function closeModalOutside(e)   { if (e.target === $("modalBackdrop")) closeModal(); }

async function saveModal() {
  const name  = $("mName").value.trim(),  photo  = $("mPhoto").value.trim();
  const start = $("mStart").value.trim(), stop   = $("mStop").value.trim();
  const horn  = $("mHorn").value.trim(),  moving = $("mMoving").value.trim();
  const rampStepSize = +$("mRampStep").value, rampStepMs = +$("mRampMs").value;
  const presets = [+$("mPre0").value || 20, +$("mPre1").value || 50, +$("mPre2").value || 80];
  if (!currentConfig[editingUuid]) currentConfig[editingUuid] = {};
  Object.assign(currentConfig[editingUuid], { name, photo, sounds: { start, stop, horn, moving }, rampStepSize, rampStepMs, presets });
  const resp = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(currentConfig),
  });
  if (resp.ok) {
    const pa = $(`photo-${editingUuid}`);
    if (pa) {
      if (photo) { pa.className = "photo-area has-photo"; pa.innerHTML = `<img src="${photo}?t=${Date.now()}" alt="">`; }
      else       { pa.className = "photo-area"; pa.innerHTML = ""; }
    }
    reloadSounds(editingUuid, { start, stop, horn, moving });
    socket.emit("setRampParams", { trainId: editingUuid, stepSize: rampStepSize, stepMs: rampStepMs });
    socket.emit("savePresets",   { trainId: editingUuid, presets });
    const presetRow = $(`presets-${editingUuid}`);
    if (presetRow)
      presetRow.innerHTML = presets
        .map((v) => `<button class="btn btn-preset" onclick="setSpeed('${esc(editingUuid)}',${v})">⚡${v}%</button>`)
        .join("");
    const sb = $("saveBtn");
    sb.className  = "btn-save saved";
    sb.textContent = "✓ СОХРАНЕНО";
    setTimeout(closeModal, 900);
  }
}

/* ── AUDIO PREVIEW ─────────────────────────────────────────────────── */
function stopPreviewAudio() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  if (previewFieldId) {
    const b = $(`prev-${previewFieldId}`);
    if (b) { b.textContent = "▶"; b.classList.remove("playing"); }
    previewFieldId = null;
  }
}
function togglePreview(fieldId) {
  if (previewFieldId === fieldId && previewAudio) { stopPreviewAudio(); return; }
  stopPreviewAudio();
  const p = $(fieldId)?.value?.trim();
  if (!p) return;
  previewAudio   = new Audio(p);
  previewFieldId = fieldId;
  const b = $(`prev-${fieldId}`);
  if (b) { b.textContent = "■"; b.classList.add("playing"); }
  previewAudio.play().catch(() => stopPreviewAudio());
  previewAudio.addEventListener("ended", () => stopPreviewAudio());
}
function previewPhoto() {
  const p = $("mPhoto")?.value?.trim(), img = $("photoPreviewImg");
  if (!p) { img.style.display = "none"; return; }
  img.src = p + "?t=" + Date.now();
  img.style.display = "block";
}

/* ── FILE BROWSER ──────────────────────────────────────────────────── */
async function openBrowser(fieldId, type) {
  document.querySelectorAll(".file-browser").forEach((fb) => {
    if (fb.id !== `fb-${fieldId}`) fb.classList.remove("open");
  });
  const fb = $(`fb-${fieldId}`);
  if (!fb) return;
  if (fb.classList.contains("open")) { fb.classList.remove("open"); return; }
  fb.dataset.type = type;
  fb.classList.add("open");
  await renderBrowser(fieldId, "");
}
async function renderBrowser(fieldId, dirPath) {
  const fb = $(`fb-${fieldId}`), type = fb.dataset.type;
  const data = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`).then((r) => r.json());
  const files = data.files.filter((f) =>
    type === "audio" ? /\.(mp3|wav|ogg|webm)$/i.test(f)
    : type === "img" ? /\.(jpg|jpeg|png|webp|gif)$/i.test(f) : true,
  );
  const parts    = dirPath ? dirPath.split("/") : [];
  const pathHtml = `<button onclick="renderBrowser('${fieldId}','')">📁 public</button>` +
    parts.map((p, i) => { const a = parts.slice(0, i + 1).join("/"); return ` / <button onclick="renderBrowser('${fieldId}','${a}')">${p}</button>`; }).join("");
  let list = "";
  if (dirPath) {
    const up = parts.slice(0, -1).join("/");
    list += `<div class="fb-item" onclick="renderBrowser('${fieldId}','${up}')"><span class="fb-ico">⬆</span>..</div>`;
  }
  data.dirs.forEach((d) => {
    const sub = dirPath ? `${dirPath}/${d}` : d;
    list += `<div class="fb-item" onclick="renderBrowser('${fieldId}','${sub}')"><span class="fb-ico">📁</span>${d}</div>`;
  });
  files.forEach((file) => {
    const full = dirPath ? `${dirPath}/${file}` : file;
    list += `<div class="fb-item" onclick="selectFile('${fieldId}','${full}',this)"><span class="fb-ico">${type === "audio" ? "🎵" : "🖼"}</span>${file}</div>`;
  });
  if (!data.dirs.length && !files.length) list = '<div class="fb-empty">Нет файлов</div>';
  fb.innerHTML = `<div class="fb-path">${pathHtml}</div><div class="fb-list">${list}</div>`;
}
function selectFile(fieldId, filePath, el) {
  $(fieldId).value = filePath;
  document.querySelectorAll(`#fb-${fieldId} .fb-item`).forEach((i) => i.classList.remove("selected"));
  el.classList.add("selected");
  setTimeout(() => $(`fb-${fieldId}`)?.classList.remove("open"), 400);
}