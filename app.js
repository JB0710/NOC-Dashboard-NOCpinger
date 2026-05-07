const POLL_MS = 5000;
const AUTO_SCROLL_STEP = 1;
const AUTO_SCROLL_INTERVAL_MS = 45;

let currentState = null;
let currentInventory = [];
let soundsEnabled = true;
let wallboardMode = false;
let minimalMode = false;
let kioskMode = false;
let autoScrollEnabled = false;
let editorOpen = false;
let autoScrollTimer = null;
let activeAlertKey = '';
let alertAcknowledged = false;
let audioUnlocked = false;

const dom = {
  wallboardToggle: document.getElementById('wallboardToggle'),
  minimalToggle: document.getElementById('minimalToggle'),
  kioskToggle: document.getElementById('kioskToggle'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
  soundToggle: document.getElementById('soundToggle'),
  autoScrollToggle: document.getElementById('autoScrollToggle'),
  ackToggle: document.getElementById('ackToggle'),
  editorToggle: document.getElementById('editorToggle'),
  editorClose: document.getElementById('editorClose'),
  editorReload: document.getElementById('editorReload'),
  editorAdd: document.getElementById('editorAdd'),
  editorSave: document.getElementById('editorSave'),
  topBadges: document.getElementById('topBadges'),
  overviewGrid: document.getElementById('overviewGrid'),
  groupsStack: document.getElementById('groupsStack'),
  wallboardBanner: document.getElementById('wallboardBanner'),
  wallboardClock: document.getElementById('wallboardClock'),
  chartsSection: document.getElementById('chartsSection'),
  fleetChart: document.getElementById('fleetChart'),
  groupChart: document.getElementById('groupChart'),
  editorDrawer: document.getElementById('editorDrawer'),
  editorRows: document.getElementById('editorRows'),
  editorMessage: document.getElementById('editorMessage'),
  addModal: document.getElementById('addModal'),
  modalClose: document.getElementById('modalClose'),
  modalAdd: document.getElementById('modalAdd'),
  newIp: document.getElementById('newIp'),
  newHostname: document.getElementById('newHostname'),
  newGroup: document.getElementById('newGroup'),
  newLocation: document.getElementById('newLocation'),
  newNotes: document.getElementById('newNotes'),
  alertOverlay: document.getElementById('alertOverlay'),
  alertText: document.getElementById('alertText'),
  overlayAckBtn: document.getElementById('overlayAckBtn'),
  alarmAudio: document.getElementById('alarmAudio')
};

dom.alarmAudio.loop = true;

function escapeHtml(value){
  return String(value ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#39;");
}

function fmtAgo(iso){
  if(!iso) return '—';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if(s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if(m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if(h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDuration(seconds){
  seconds = Number(seconds || 0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if(days > 0) return `${days}d ${hours}h ${mins}m`;
  if(hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function latencyClass(ms){
  if(ms == null || !Number.isFinite(ms)) return 'info';
  if(ms < 50) return 'up';
  if(ms < 120) return 'warn';
  return 'down';
}

function statusPriority(status){
  switch((status || '').toLowerCase()){
    case 'down': return 0;
    case 'warning': return 1;
    case 'up': return 2;
    default: return 3;
  }
}

function statusIcon(status){
  switch((status || '').toLowerCase()){
    case 'up':
      return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#35d487" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12l2 2 4-4"/></svg>`;
    case 'warning':
      return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ffbc42" stroke-width="2"><path d="M12 3L22 20H2L12 3Z"/><path d="M12 9v4"/><circle cx="12" cy="17" r="1"/></svg>`;
    case 'down':
      return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ff6474" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`;
    default:
      return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4dc9ff" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;
  }
}

function updateUrlFlags(){
  const url = new URL(window.location.href);

  if (wallboardMode) url.searchParams.set('wallboard', '1'); else url.searchParams.delete('wallboard');
  if (minimalMode) url.searchParams.set('minimal', '1'); else url.searchParams.delete('minimal');
  if (kioskMode) url.searchParams.set('kiosk', '1'); else url.searchParams.delete('kiosk');
  if (autoScrollEnabled) url.searchParams.set('autoscroll', '1'); else url.searchParams.delete('autoscroll');

  history.replaceState({}, '', url.toString());
}

function updateButtons(){
  dom.wallboardToggle.classList.toggle('active', wallboardMode);
  dom.minimalToggle.classList.toggle('active', minimalMode);
  dom.kioskToggle.classList.toggle('active', kioskMode);
  dom.autoScrollToggle.classList.toggle('active', autoScrollEnabled);
  dom.soundToggle.classList.toggle('active', soundsEnabled);
  dom.editorToggle.classList.toggle('active', editorOpen);
  dom.ackToggle.classList.toggle('active', alertAcknowledged);

  dom.wallboardToggle.textContent = `Wallboard: ${wallboardMode ? 'On' : 'Off'}`;
  dom.minimalToggle.textContent = `Minimal: ${minimalMode ? 'On' : 'Off'}`;
  dom.kioskToggle.textContent = `Kiosk: ${kioskMode ? 'On' : 'Off'}`;
  dom.autoScrollToggle.textContent = `Auto Scroll: ${autoScrollEnabled ? 'On' : 'Off'}`;
  dom.soundToggle.textContent = `Sound: ${soundsEnabled ? 'On' : 'Off'}`;
  dom.ackToggle.textContent = alertAcknowledged ? 'Alert Acknowledged' : 'Acknowledge Alert';
}

function setWallboardMode(enabled){
  wallboardMode = enabled;
  document.body.classList.toggle('wallboard', enabled);
  updateButtons();
  updateUrlFlags();
}

function setMinimalMode(enabled){
  minimalMode = enabled;
  document.body.classList.toggle('minimal', enabled);
  updateButtons();
  updateUrlFlags();
  rerender();
}

async function setKioskMode(enabled){
  kioskMode = enabled;
  document.documentElement.classList.toggle('kiosk', enabled);
  document.body.classList.toggle('kiosk', enabled);

  if (enabled) {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      }
    } catch (err) {
      console.error(err);
    }
  } else {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error(err);
    }
  }

  updateButtons();
  updateUrlFlags();
}

function startAutoScroll(){
  stopAutoScroll();
  autoScrollTimer = window.setInterval(() => {
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (maxY <= 0) return;

    const nextY = window.scrollY + AUTO_SCROLL_STEP;
    if (nextY >= maxY) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    } else {
      window.scrollTo({ top: nextY, behavior: 'auto' });
    }
  }, AUTO_SCROLL_INTERVAL_MS);
}

function stopAutoScroll(){
  if (autoScrollTimer) {
    clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
}

function setAutoScroll(enabled){
  autoScrollEnabled = enabled;
  if (enabled) startAutoScroll(); else stopAutoScroll();
  updateButtons();
  updateUrlFlags();
}

function stopAlarm(){
  dom.alarmAudio.pause();
  dom.alarmAudio.currentTime = 0;
}

function tryUnlockAudio(){
  if (audioUnlocked) return;
  dom.alarmAudio.play()
    .then(() => {
      dom.alarmAudio.pause();
      dom.alarmAudio.currentTime = 0;
      audioUnlocked = true;
    })
    .catch(() => {});
}

function playAlarm(){
  if (!soundsEnabled) return;
  if (!audioUnlocked) return;
  dom.alarmAudio.play().catch(() => {});
}

function acknowledgeAlert(){
  alertAcknowledged = true;
  stopAlarm();
  dom.alertOverlay.classList.add('hidden');
  updateButtons();
}

function updateClock(){
  dom.wallboardClock.textContent = new Date().toLocaleTimeString();
}

function buildOverview(state){
  const devices = state.devices || [];
  const total = devices.length;
  const up = devices.filter(d => d.status === 'up').length;
  const down = devices.filter(d => d.status === 'down').length;
  const warning = devices.filter(d => d.status === 'warning').length;
  const latencyValues = devices.map(d => d.lastLatencyMs).filter(v => Number.isFinite(v));
  const avgLatency = latencyValues.length
    ? Math.round(latencyValues.reduce((a,b)=>a+b,0) / latencyValues.length)
    : null;

  dom.overviewGrid.innerHTML = `
    <div class="metric info">
      <div class="metric-icon">${statusIcon('info')}</div>
      <div class="metric-value">${total}</div>
      <div class="metric-label">Total Devices</div>
    </div>
    <div class="metric up">
      <div class="metric-icon">${statusIcon('up')}</div>
      <div class="metric-value">${up}</div>
      <div class="metric-label">Up</div>
    </div>
    <div class="metric down">
      <div class="metric-icon">${statusIcon('down')}</div>
      <div class="metric-value">${down}</div>
      <div class="metric-label">Down</div>
    </div>
    <div class="metric warn">
      <div class="metric-icon">${statusIcon('warning')}</div>
      <div class="metric-value">${warning}</div>
      <div class="metric-label">Warning</div>
    </div>
    <div class="metric ${latencyClass(avgLatency)}">
      <div class="metric-icon">⏱️</div>
      <div class="metric-value">${avgLatency == null ? '—' : avgLatency + ' ms'}</div>
      <div class="metric-label">Average Latency</div>
    </div>
  `;

  dom.topBadges.innerHTML = `
    <div class="badge"><strong>${up}</strong> Up</div>
    <div class="badge"><strong>${down}</strong> Down</div>
    <div class="badge"><strong>${warning}</strong> Warning</div>
    <div class="badge">Started <strong>${fmtAgo(state.startedAt)}</strong></div>
  `;
}

function groupDevices(devices){
  return {
    core: devices.filter(d => d.group === 'core'),
    distribution: devices.filter(d => d.group === 'distribution'),
    access: devices.filter(d => d.group === 'access')
  };
}

function summarizeGroup(list){
  const latencyValues = list.map(d => d.lastLatencyMs).filter(v => Number.isFinite(v));
  return {
    total: list.length,
    up: list.filter(d => d.status === 'up').length,
    down: list.filter(d => d.status === 'down').length,
    warning: list.filter(d => d.status === 'warning').length,
    avgLatency: latencyValues.length
      ? Math.round(latencyValues.reduce((a,b)=>a+b,0) / latencyValues.length)
      : null
  };
}

function buildGroups(state){
  const grouped = groupDevices(state.devices || []);
  const order = [
    { key:'core', title:'Core Devices', icon:'🧠' },
    { key:'distribution', title:'Distribution Switches', icon:'🌐' },
    { key:'access', title:'Access Switches', icon:'🖧' }
  ];

  const html = order.map(group => {
    const list = [...grouped[group.key]].sort((a, b) => statusPriority(a.status) - statusPriority(b.status));
    const summary = summarizeGroup(list);

    return `
      <section class="group-panel">
        <div class="group-header">
          <div class="group-title">
            <div style="font-size:1.4rem">${group.icon}</div>
            <div>
              <h2>${group.title}</h2>
              <div class="group-sub">${summary.total} device(s) in this group</div>
            </div>
          </div>
          <div class="group-summary">
            <div class="summary-pill">Up: ${summary.up}</div>
            <div class="summary-pill">Down: ${summary.down}</div>
            <div class="summary-pill">Warning: ${summary.warning}</div>
            ${minimalMode ? '' : `<div class="summary-pill">Avg Latency: ${summary.avgLatency == null ? '—' : summary.avgLatency + ' ms'}</div>`}
          </div>
        </div>

        <div class="group-devices">
          ${list.map(device => `
            <article class="device-card ${escapeHtml(device.status || 'unknown')}">
              <div class="device-top">
                <div class="device-name">
                  <div class="status-dot ${escapeHtml(device.status || 'unknown')}"></div>
                  <div>
                    <div class="device-title">${escapeHtml(device.hostname || device.displayName || device.target)}</div>
                    <div class="device-meta">
                      ${minimalMode
                        ? `${escapeHtml(device.location || 'Unknown')}`
                        : `${escapeHtml(device.target)}<br>${escapeHtml(device.location || 'Unknown')}<br>${escapeHtml(device.notes || '')}${device.notes ? '<br>' : ''}Last good: ${escapeHtml(fmtAgo(device.lastSuccess))}`
                      }
                    </div>
                  </div>
                </div>
                <div class="status-chip ${escapeHtml(device.status || 'unknown')}">${escapeHtml(device.status || 'unknown')}</div>
              </div>

              ${minimalMode ? '' : `
              <div class="device-stats">
                <div class="stat">
                  <div class="stat-label">Latency</div>
                  <div class="stat-value">${device.lastLatencyMs == null ? '—' : device.lastLatencyMs + ' ms'}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Loss</div>
                  <div class="stat-value">${device.packetLossPercent ?? 0}%</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Uptime</div>
                  <div class="stat-value">${device.uptimePercent ?? 0}%</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Downtime</div>
                  <div class="stat-value">${formatDuration(device.totalDowntimeSec || 0)}</div>
                </div>
              </div>`}
            </article>
          `).join('')}
        </div>
      </section>
    `;
  }).join('');

  dom.groupsStack.innerHTML = html;
}

function roundRect(ctx, x, y, width, height, radius){
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function renderFleetChart(state){
  const canvas = dom.fleetChart;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.max(600, rect.width * dpr);
  canvas.height = 240 * dpr;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = 240;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = 'rgba(255,255,255,.02)';
  roundRect(ctx, 0, 0, w, h, 18);
  ctx.fill();

  const series = (state.devices || [])
    .map(d => ({
      points: (d.history || []).slice(-24).map((x, i) => ({ i, value: x.up ? x.latencyMs : null }))
    }))
    .filter(s => s.points.length > 1);

  const allValues = series.flatMap(s => s.points.map(p => p.value).filter(v => Number.isFinite(v)));
  const max = Math.max(30, ...(allValues.length ? allValues : [30]));

  const left = 48, right = 18, top = 14, bottom = 34;
  const cw = w - left - right;
  const ch = h - top - bottom;

  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  for(let i=0;i<=4;i++){
    const y = top + (ch / 4) * i;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
  }

  const palette = ['#4dc9ff','#35d487','#ffbc42','#ff6474','#9f8cff','#7dd3fc','#a3e635','#f9a8d4'];

  series.slice(0,8).forEach((serie, idx) => {
    const color = palette[idx % palette.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    let started = false;

    serie.points.forEach((point, i) => {
      if(!Number.isFinite(point.value)) return;
      const x = left + (i / Math.max(1, serie.points.length - 1)) * cw;
      const y = top + ch - (point.value / max) * ch;
      if(!started){
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
  });
}

function renderGroupChart(state){
  const canvas = dom.groupChart;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.max(500, rect.width * dpr);
  canvas.height = 240 * dpr;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = 240;
  ctx.clearRect(0,0,w,h);

  ctx.fillStyle = 'rgba(255,255,255,.02)';
  roundRect(ctx, 0, 0, w, h, 18);
  ctx.fill();

  const groups = [
    { key:'core', label:'Core', color:'#4dc9ff' },
    { key:'distribution', label:'Distribution', color:'#35d487' },
    { key:'access', label:'Access', color:'#ffbc42' }
  ];

  const grouped = groupDevices(state.devices || []);
  const values = groups.map(group => {
    const nums = grouped[group.key].map(d => d.lastLatencyMs).filter(v => Number.isFinite(v));
    return nums.length ? Math.round(nums.reduce((a,b)=>a+b,0)/nums.length) : 0;
  });

  const max = Math.max(50, ...values, 1);
  const left = 70;
  const baseY = 190;
  const top = 24;
  const chartHeight = baseY - top;
  const barWidth = Math.min(120, Math.max(70, (w - 220) / 3));
  const gap = Math.max(40, (w - left - (barWidth * 3) - 80) / 2);

  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;

  for(let i=0;i<=4;i++){
    const y = top + (chartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - 30, y);
    ctx.stroke();

    const label = Math.round(max - (max / 4) * i) + ' ms';
    ctx.fillStyle = 'rgba(147,169,203,.9)';
    ctx.font = '12px Segoe UI';
    ctx.fillText(label, 10, y + 4);
  }

  groups.forEach((group, i) => {
    const value = values[i];
    const x = left + 30 + i * (barWidth + gap);
    const barHeight = value > 0 ? (value / max) * chartHeight : 4;
    const y = baseY - barHeight;

    ctx.fillStyle = group.color;
    ctx.fillRect(x, y, barWidth, barHeight);

    ctx.fillStyle = 'rgba(238,244,255,.92)';
    ctx.font = '14px Segoe UI';
    ctx.fillText(group.label, x + 10, baseY + 24);
    ctx.fillText(value > 0 ? `${value} ms` : '—', x + 16, y - 8);
  });
}

function stopAlarm(){
  dom.alarmAudio.pause();
  dom.alarmAudio.currentTime = 0;
}

function tryUnlockAudio(){
  if (audioUnlocked) return;
  dom.alarmAudio.play()
    .then(() => {
      dom.alarmAudio.pause();
      dom.alarmAudio.currentTime = 0;
      audioUnlocked = true;
    })
    .catch(() => {});
}

function playAlarm(){
  if (!soundsEnabled) return;
  if (!audioUnlocked) return;
  dom.alarmAudio.play().catch(() => {});
}

function updateBanner(state){
  const down = (state.devices || []).filter(d => d.status === 'down');

  if(down.length > 0){
    dom.wallboardBanner.className = 'wallboard-banner down';
    dom.wallboardBanner.textContent = `🚨 ${down.length} DEVICE(S) DOWN: ${down.map(d => d.hostname || d.target).join(', ')}`;
  } else {
    dom.wallboardBanner.className = 'wallboard-banner';
    dom.wallboardBanner.textContent = '';
  }
}

function handleAlerts(state){
  const downDevices = (state.devices || []).filter(d => d.status === 'down');
  const newKey = downDevices.map(d => d.target).sort().join('|');

  if (!downDevices.length) {
    activeAlertKey = '';
    alertAcknowledged = false;
    dom.alertOverlay.classList.add('hidden');
    stopAlarm();
    updateButtons();
    return;
  }

  if (newKey !== activeAlertKey) {
    activeAlertKey = newKey;
    alertAcknowledged = false;
  }

  if (!alertAcknowledged) {
    dom.alertText.textContent = `${downDevices.length} device(s) down: ${downDevices.map(d => d.hostname || d.target).join(', ')}`;
    dom.alertOverlay.classList.remove('hidden');
    playAlarm();
  } else {
    dom.alertOverlay.classList.add('hidden');
    stopAlarm();
  }

  updateButtons();
}

function acknowledgeAlert(){
  alertAcknowledged = true;
  dom.alertOverlay.classList.add('hidden');
  stopAlarm();
  updateButtons();
}

function setEditorOpen(enabled){
  editorOpen = enabled;
  dom.editorDrawer.classList.toggle('open', enabled);
  updateButtons();
}

function setEditorMessage(message, type = ''){
  dom.editorMessage.className = `editor-message ${type}`.trim();
  dom.editorMessage.textContent = message || '';
}

async function loadInventory(){
  const res = await fetch('/api/devices', { cache: 'no-store' });
  const payload = await res.json();
  currentInventory = payload.devices || [];
  renderEditorRows();
}

function renderEditorRows(){
  dom.editorRows.innerHTML = currentInventory.map((device, index) => `
    <div class="editor-row" data-index="${index}">
      <div class="editor-grid">
        <div class="field">
          <label>IP Address</label>
          <input data-field="ip" value="${escapeHtml(device.ip || '')}">
        </div>
        <div class="field">
          <label>Hostname</label>
          <input data-field="hostname" value="${escapeHtml(device.hostname || '')}">
        </div>
        <div class="field">
          <label>Group</label>
          <select data-field="group">
            <option value="core" ${device.group === 'core' ? 'selected' : ''}>core</option>
            <option value="distribution" ${device.group === 'distribution' ? 'selected' : ''}>distribution</option>
            <option value="access" ${device.group === 'access' ? 'selected' : ''}>access</option>
          </select>
        </div>
        <div class="field">
          <label>Location</label>
          <input data-field="location" value="${escapeHtml(device.location || '')}">
        </div>
        <div class="field span-2">
          <label>Notes</label>
          <input data-field="notes" value="${escapeHtml(device.notes || '')}">
        </div>
      </div>
      <div class="row-actions">
        <button class="btn" data-delete="${index}">Delete</button>
      </div>
    </div>
  `).join('');

  dom.editorRows.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-delete'));
      currentInventory.splice(idx, 1);
      renderEditorRows();
    });
  });
}

function collectEditorRows(){
  const rows = Array.from(dom.editorRows.querySelectorAll('.editor-row'));
  return rows.map(row => {
    const get = field => row.querySelector(`[data-field="${field}"]`).value.trim();
    return {
      ip: get('ip'),
      hostname: get('hostname'),
      group: get('group'),
      location: get('location'),
      notes: get('notes')
    };
  });
}

async function saveInventory(){
  try {
    setEditorMessage('Saving...', '');
    const devices = collectEditorRows();
    const res = await fetch('/api/devices', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices })
    });

    const payload = await res.json();
    if (!res.ok || payload.ok === false) {
      throw new Error(payload.error || 'Save failed.');
    }

    setEditorMessage('Saved successfully.', 'success');
    await loadInventory();
    await loadState();
  } catch (err) {
    setEditorMessage(err.message, 'error');
  }
}

function openAddModal(){
  dom.addModal.classList.remove('hidden');
  dom.newIp.value = '';
  dom.newHostname.value = '';
  dom.newGroup.value = 'access';
  dom.newLocation.value = '';
  dom.newNotes.value = '';
  dom.newIp.focus();
}

function closeAddModal(){
  dom.addModal.classList.add('hidden');
}

function addDeviceFromModal(){
  currentInventory.push({
    ip: dom.newIp.value.trim(),
    hostname: dom.newHostname.value.trim(),
    group: dom.newGroup.value.trim(),
    location: dom.newLocation.value.trim(),
    notes: dom.newNotes.value.trim()
  });
  renderEditorRows();
  closeAddModal();
}

function rerender(){
  if(!currentState) return;

  buildOverview(currentState);
  buildGroups(currentState);

  if (!minimalMode) {
    renderFleetChart(currentState);
    renderGroupChart(currentState);
  }

  updateBanner(currentState);
  handleAlerts(currentState);
}

async function loadState(){
  const res = await fetch('/api/state', { cache:'no-store' });
  currentState = await res.json();
  rerender();
}

window.addEventListener('load', async () => {
  const qs = new URLSearchParams(window.location.search);
  wallboardMode = qs.get('wallboard') === '1';
  minimalMode = qs.get('minimal') === '1';
  kioskMode = qs.get('kiosk') === '1';
  autoScrollEnabled = qs.get('autoscroll') === '1';

  document.body.classList.toggle('wallboard', wallboardMode);
  document.body.classList.toggle('minimal', minimalMode);
  document.body.classList.toggle('kiosk', kioskMode);
  document.documentElement.classList.toggle('kiosk', kioskMode);

  updateButtons();

  document.body.addEventListener('click', tryUnlockAudio, { once: true });

  if('Notification' in window && Notification.permission === 'default'){
    Notification.requestPermission().catch(() => {});
  }

  if (kioskMode && !document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen();
    } catch (err) {
      console.error(err);
    }
  }

  if (autoScrollEnabled) {
    startAutoScroll();
  }

  updateClock();
  setInterval(updateClock, 1000);

  dom.wallboardToggle.addEventListener('click', () => setWallboardMode(!wallboardMode));
  dom.minimalToggle.addEventListener('click', () => setMinimalMode(!minimalMode));
  dom.kioskToggle.addEventListener('click', async () => await setKioskMode(!kioskMode));
  dom.soundToggle.addEventListener('click', () => {
    soundsEnabled = !soundsEnabled;
    if (!soundsEnabled) stopAlarm();
    updateButtons();
  });
  dom.autoScrollToggle.addEventListener('click', () => setAutoScroll(!autoScrollEnabled));
  dom.ackToggle.addEventListener('click', () => acknowledgeAlert());
  dom.overlayAckBtn.addEventListener('click', () => acknowledgeAlert());

  dom.fullscreenBtn.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error(err);
    }
  });

  dom.editorToggle.addEventListener('click', async () => {
    setEditorOpen(!editorOpen);
    if (editorOpen) {
      setEditorMessage('');
      await loadInventory();
    }
  });

  dom.editorClose.addEventListener('click', () => setEditorOpen(false));
  dom.editorReload.addEventListener('click', async () => {
    await loadInventory();
    setEditorMessage('Reloaded from file.', 'success');
  });
  dom.editorAdd.addEventListener('click', () => openAddModal());
  dom.editorSave.addEventListener('click', async () => await saveInventory());

  dom.modalClose.addEventListener('click', () => closeAddModal());
  dom.modalAdd.addEventListener('click', () => addDeviceFromModal());
  dom.addModal.addEventListener('click', (e) => {
    if (e.target === dom.addModal) closeAddModal();
  });

  window.addEventListener('keydown', async (e) => {
    if (e.key.toLowerCase() === 'w') setWallboardMode(!wallboardMode);
    if (e.key.toLowerCase() === 'm') setMinimalMode(!minimalMode);
    if (e.key.toLowerCase() === 'k') await setKioskMode(!kioskMode);
    if (e.key.toLowerCase() === 's') {
      soundsEnabled = !soundsEnabled;
      if (!soundsEnabled) stopAlarm();
      updateButtons();
    }
    if (e.key.toLowerCase() === 'a') acknowledgeAlert();
  });

  await loadState();
  setInterval(loadState, POLL_MS);
});

window.addEventListener('resize', () => {
  if(currentState && !minimalMode){
    renderFleetChart(currentState);
    renderGroupChart(currentState);
  }
});