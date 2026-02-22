// ========================================
// delivery.js v3 — Throughput-based tracking
// ========================================
var DELIVERY_API = (typeof APIBASE !== 'undefined' && APIBASE) ? APIBASE : '';

let deliveryInterval = null;
let truckMarkers = {};
let lastNonEmptyTrucks = [];

// ===== RENDER CONFIG FORM =====
function renderDeliveryForm() {
  const container = document.getElementById('projectRouteInfo');
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="padding:10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;">
        <div style="font-size:12px;color:#0369a1;font-weight:600;margin-bottom:4px;">📍 Full Project Corridor</div>
        <div style="font-size:11px;color:#6b7280;">
          Concrete Plant (S) → Construction Site (E)<br>
          All 92 segments · Speed capped at 60 km/h
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div>
          <label style="font-size:12px;color:#6b7280;">Target Volume (m³)</label>
          <input id="deliveryTarget" type="number" value="600" min="1"
            style="width:100%;padding:6px;border:1px solid #e5e7eb;border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="font-size:12px;color:#6b7280;">Per Truck (m³)</label>
          <input id="deliveryPerTruck" type="number" value="8" min="1" max="20"
            style="width:100%;padding:6px;border:1px solid #e5e7eb;border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="font-size:12px;color:#6b7280;">Trucks/Hour Target</label>
          <input id="deliveryFrequency" type="number" value="12" min="1" max="30"
            style="width:100%;padding:6px;border:1px solid #e5e7eb;border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="font-size:12px;color:#6b7280;">Default Speed (km/h)</label>
          <input id="deliverySpeed" type="number" value="40" min="5" max="60"
            style="width:100%;padding:6px;border:1px solid #e5e7eb;border-radius:4px;font-size:13px;">
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="btnStartDelivery" onclick="startDelivery()"
          style="flex:1;padding:8px;background:#22c55e;color:white;border:none;border-radius:6px;font-weight:600;cursor:pointer;">
          ▶ Start Delivery
        </button>
        <button id="btnStopDelivery" onclick="stopDeliverySession()"
          style="flex:1;padding:8px;background:#ef4444;color:white;border:none;border-radius:6px;font-weight:600;cursor:pointer;display:none;">
          ⏹ Stop
        </button>
        <button onclick="resetDeliverySession()"
          style="padding:8px 12px;background:#6b7280;color:white;border:none;border-radius:6px;cursor:pointer;">
          ↺
        </button>
      </div>
    </div>
  `;
}

// ===== START =====
async function startDelivery() {
  var body = {
    targetVolume: Number(document.getElementById('deliveryTarget').value),
    volumePerTruck: Number(document.getElementById('deliveryPerTruck').value),
    trucksPerHour: Number(document.getElementById('deliveryFrequency').value),
    defaultSpeed: Number(document.getElementById('deliverySpeed').value)
  };

  try {
    var resp = await fetch(DELIVERY_API + 'api/delivery/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await resp.json();
    if (!resp.ok) { alert('Error: ' + (data.error || 'Unknown')); return; }
    console.log('Delivery started:', data);

    document.getElementById('btnStartDelivery').style.display = 'none';
    document.getElementById('btnStopDelivery').style.display = 'block';

    pollDeliveryStatus();
    deliveryInterval = setInterval(pollDeliveryStatus, 3000);

    if (typeof zoomToProjectRoutes === 'function') zoomToProjectRoutes();
  } catch (err) {
    console.error('Failed to start delivery:', err);
    alert('Failed to start delivery: ' + err.message);
  }
}

// ===== STOP =====
async function stopDeliverySession() {
  try {
    await fetch(DELIVERY_API + 'api/delivery/stop', { method: 'POST' });
    if (deliveryInterval) { clearInterval(deliveryInterval); deliveryInterval = null; }
    document.getElementById('btnStartDelivery').style.display = 'block';
    document.getElementById('btnStopDelivery').style.display = 'none';
  } catch (err) { console.error(err); }
}

// ===== RESET =====
async function resetDeliverySession() {
  try {
    await fetch(DELIVERY_API + 'api/delivery/reset', { method: 'POST' });
    if (deliveryInterval) { clearInterval(deliveryInterval); deliveryInterval = null; }
    Object.values(truckMarkers).forEach(function(m) { map.removeLayer(m); });
    truckMarkers = {};
    document.getElementById('btnStartDelivery').style.display = 'block';
    document.getElementById('btnStopDelivery').style.display = 'none';
    document.getElementById('projectVehicleList').innerHTML = '';
    document.getElementById('projectPerformance').innerHTML = 'No active delivery.';
    renderDeliveryForm();
  } catch (err) { console.error(err); }
}

// ===== POLL =====
async function pollDeliveryStatus() {
  try {
    var resp = await fetch(DELIVERY_API + 'api/delivery/status');
    var data = await resp.json();
    if (!data.running) return;
    updateDeliveryUI(data);
    updateTruckMarkers(data.trucks || []);
  } catch (err) { console.error('Poll error:', err); }
}

// ===== UPDATE UI =====
function updateDeliveryUI(data) {
  var p = data.progress;
  var c = data.config;
  var tp = data.throughput;
  var pct = p.percentComplete;
  var barColor = tp.behindSchedule ? '#ef4444' : '#22c55e';

  // --- Progress + Throughput ---
  var throughputHtml = '';
  if (tp.behindSchedule) {
    throughputHtml =
      '<div style="margin-top:8px;padding:8px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:12px;color:#dc2626;">' +
        '⚠️ Behind schedule: <b>' + tp.windowActual + '/' + tp.windowTarget + '</b> trucks this hour' +
        (tp.delayMinutes > 0 ? ' · Projected delay: <b>+' + tp.delayMinutes + ' min</b>' : '') +
      '</div>';
  } else if (tp.actualRate > 0) {
    throughputHtml =
      '<div style="margin-top:8px;padding:8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:12px;color:#166534;">' +
        '✅ On schedule: <b>' + tp.actualRate + '</b> trucks/hr (target: ' + tp.targetRate + ')' +
      '</div>';
  }

  document.getElementById('projectRouteInfo').innerHTML =
    '<div style="margin-bottom:12px;">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-bottom:4px;">' +
        '<span>Corridor · ' + c.totalDistance + ' km</span>' +
        '<span>' + p.delivered + ' / ' + c.targetVolume + ' m³</span>' +
      '</div>' +
      '<div style="background:#e5e7eb;border-radius:8px;height:20px;overflow:hidden;">' +
        '<div style="background:' + barColor + ';height:100%;width:' + pct + '%;border-radius:8px;transition:width 0.5s;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:600;">' +
          pct + '%' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;">' +
      '<div><span style="color:#6b7280;">En Route:</span> <b>' + p.trucksEnRoute + '</b></div>' +
      '<div><span style="color:#6b7280;">Arrived:</span> <b>' + p.trucksCompleted + '</b></div>' +
      '<div><span style="color:#6b7280;">Waiting:</span> <b>' + p.trucksWaiting + '</b></div>' +
      '<div><span style="color:#6b7280;">Rate:</span> <b>' + tp.actualRate + '</b>/hr</div>' +
    '</div>' +
    throughputHtml +
    '<div style="margin-top:8px;display:flex;gap:8px;">' +
      '<button onclick="stopDeliverySession()" style="flex:1;padding:6px;background:#ef4444;color:white;border:none;border-radius:4px;font-size:12px;cursor:pointer;">⏹ Stop</button>' +
      '<button onclick="resetDeliverySession()" style="padding:6px 10px;background:#6b7280;color:white;border:none;border-radius:4px;font-size:12px;cursor:pointer;">↺ Reset</button>' +
    '</div>';

  // --- Truck list (show travel time + ETA, not speed) ---
  var truckList = document.getElementById('projectVehicleList');
  var trucks = data.trucks || [];
  if (trucks.length === 0) {
    truckList.innerHTML = '<div style="padding:12px;color:#6b7280;font-size:13px;">No trucks dispatched yet.</div>';
  } else {
    truckList.innerHTML = trucks.map(function(t) {
      var statusColor = t.status === 'en-route' ? '#3b82f6' : '#22c55e';
      var statusIcon = t.status === 'en-route' ? '🚛' : '✅';
      var etaStr = t.status === 'en-route'
        ? new Date(t.estimatedArrival).toLocaleTimeString('en-HK', { hour: '2-digit', minute: '2-digit' })
        : new Date(t.arrivalTime).toLocaleTimeString('en-HK', { hour: '2-digit', minute: '2-digit' });
      var remainSec = 0;
      if (t.status === 'en-route') {
        remainSec = Math.max(0, Math.round((new Date(t.estimatedArrival).getTime() - Date.now()) / 1000));
      }
      var remainMin = Math.round(remainSec / 60);
      var travelMin = Math.round(t.elapsedSeconds / 60);

      return '<div class="vehicle-item" style="border-left:3px solid ' + statusColor + ';">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span class="vehicle-item-id">' + statusIcon + ' ' + t.truckId + '</span>' +
          '<span style="font-size:11px;padding:2px 6px;border-radius:3px;background:' + statusColor + '20;color:' + statusColor + ';">' +
            (t.status === 'en-route' ? t.progress + '%' : 'Arrived') +
          '</span>' +
        '</div>' +
        '<div class="vehicle-item-eta">' +
          (t.status === 'en-route'
            ? remainMin + ' min left · Arriving: ' + etaStr
            : 'Arrived: ' + etaStr + ' · ' + travelMin + ' min trip · ' + t.concreteVolume + 'm³') +
        '</div></div>';
    }).join('');
  }

  // --- Performance panel (throughput focused) ---
  var perfPanel = document.getElementById('projectPerformance');
  var log = data.deliveryLog || [];
  var avgTravel = log.length > 0
    ? (log.reduce(function(s, r) { return s + r.travelTimeMinutes; }, 0) / log.length).toFixed(1)
    : '-';

  // Hourly breakdown
  var hourlyHtml = '';
  if (tp.hourlyBreakdown && tp.hourlyBreakdown.length > 0) {
    hourlyHtml = '<div style="margin-top:10px;border-top:1px solid #e5e7eb;padding-top:8px;">' +
      '<div style="font-size:11px;color:#6b7280;margin-bottom:6px;font-weight:600;">Hourly Throughput</div>';
    tp.hourlyBreakdown.forEach(function(h) {
      var pctH = h.target > 0 ? Math.round((h.actual / h.target) * 100) : 0;
      var hColor = h.diff >= 0 ? '#22c55e' : '#ef4444';
      var diffStr = h.diff >= 0 ? '+' + h.diff : '' + h.diff;
      hourlyHtml +=
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:4px;">' +
          '<span>Hour ' + (h.hour + 1) + '</span>' +
          '<span><b>' + h.actual + '</b>/' + h.target +
            ' <span style="color:' + hColor + ';font-size:11px;">(' + diffStr + ')</span></span>' +
        '</div>';
    });
    hourlyHtml += '</div>';
  }

  perfPanel.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">' +
      '<div><div style="color:#6b7280;font-size:11px;">Target</div><div style="font-weight:600;">' + c.targetVolume + ' m³</div></div>' +
      '<div><div style="color:#6b7280;font-size:11px;">Delivered</div><div style="font-weight:600;color:#22c55e;">' + p.delivered + ' m³</div></div>' +
      '<div><div style="color:#6b7280;font-size:11px;">Avg Travel</div><div style="font-weight:600;">' + avgTravel + ' min</div></div>' +
      '<div><div style="color:#6b7280;font-size:11px;">Throughput</div><div style="font-weight:600;color:' + (tp.behindSchedule ? '#ef4444' : '#22c55e') + ';">' + tp.actualRate + '/hr</div></div>' +
    '</div>' +
    (p.estimatedCompletion
      ? '<div style="margin-top:10px;padding:8px;background:' + (tp.behindSchedule ? '#fef2f2' : '#f0fdf4') + ';border:1px solid ' + (tp.behindSchedule ? '#fecaca' : '#bbf7d0') + ';border-radius:6px;">' +
          '<div style="font-size:11px;color:#6b7280;">Projected Completion</div>' +
          '<div style="font-size:14px;font-weight:600;color:' + (tp.behindSchedule ? '#dc2626' : '#22c55e') + ';">' +
            new Date(p.estimatedCompletion).toLocaleTimeString('en-HK') +
            (tp.delayMinutes > 0 ? ' <span style="font-size:12px;font-weight:400;">(+' + tp.delayMinutes + ' min delay)</span>' : ' <span style="font-size:12px;font-weight:400;">(on schedule)</span>') +
          '</div></div>'
      : '') +
    hourlyHtml;
}

// ===== TRUCK MARKERS =====
function updateTruckMarkers(trucks) {
  // Smooth out brief empty/partial responses
  if (!trucks || trucks.length === 0) {
    trucks = lastNonEmptyTrucks;
  } else {
    lastNonEmptyTrucks = trucks;
  }

  var currentIds = {};
  trucks.forEach(function (t) { currentIds[t.truckId] = true; });

  Object.keys(truckMarkers).forEach(function (id) {
    if (!currentIds[id]) {
      map.removeLayer(truckMarkers[id]);
      delete truckMarkers[id];
    }
  });

  trucks.forEach(function (t) {
    if (!t.position || t.position[0] === 0) return;
    var latLng = [t.position[1], t.position[0]];
    var isArrived = t.status === 'arrived';
    var bgColor = isArrived ? '#22c55e' : '#3b82f6';
    var emoji = isArrived ? '✅' : '🚛';
    var popupContent = buildTruckPopup(t);

    if (truckMarkers[t.truckId]) {
      truckMarkers[t.truckId].setLatLng(latLng);
      truckMarkers[t.truckId].setPopupContent(popupContent);
      if (isArrived) {
        truckMarkers[t.truckId].setIcon(makeTruckIcon(bgColor, emoji));
      }
    } else {
      var marker = L.marker(latLng, {
        icon: makeTruckIcon(bgColor, emoji),
        zIndexOffset: 1000
      }).bindPopup(popupContent).addTo(map);
      truckMarkers[t.truckId] = marker;
    }
  });
}


function buildTruckPopup(t) {
  var remainSec = 0;
  if (t.status === 'en-route') {
    remainSec = Math.max(0, Math.round((new Date(t.estimatedArrival).getTime() - Date.now()) / 1000));
  }
  var remainMin = Math.round(remainSec / 60);
  var travelMin = Math.round(t.elapsedSeconds / 60);
  var etaStr = t.status === 'en-route'
    ? new Date(t.estimatedArrival).toLocaleTimeString('en-HK', { hour: '2-digit', minute: '2-digit' })
    : new Date(t.arrivalTime).toLocaleTimeString('en-HK', { hour: '2-digit', minute: '2-digit' });

  if (t.status === 'en-route') {
    return '<b>' + t.truckId + '</b><br>' +
      'Progress: ' + t.progress + '%<br>' +
      'Time left: ' + remainMin + ' min<br>' +
      'Arriving: ' + etaStr + '<br>' +
      'Volume: ' + t.concreteVolume + ' m³';
  } else {
    return '<b>' + t.truckId + '</b><br>' +
      'Arrived: ' + etaStr + '<br>' +
      'Trip time: ' + travelMin + ' min<br>' +
      'Delivered: ' + t.concreteVolume + ' m³';
  }
}

function makeTruckIcon(bgColor, emoji) {
  return L.divIcon({
    className: 'truck-marker',
    html: '<div style="' +
      'background:' + bgColor + ';' +
      'width:26px;height:26px;border-radius:50%;' +
      'border:2px solid white;' +
      'box-shadow:0 2px 6px rgba(0,0,0,0.3);' +
      'display:flex;align-items:center;justify-content:center;' +
      'font-size:13px;">' + emoji + '</div>',
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
}