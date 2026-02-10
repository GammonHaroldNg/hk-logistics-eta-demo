// ========================================
// delivery.js — Concrete Delivery Tracking
// ========================================
// Depends on globals from index.html:
//   map, allRoutes, zoomToRoute, zoomToProjectRoutes

// ===== API BASE (same-origin fallback) =====
var DELIVERY_API = (typeof APIBASE !== 'undefined' && APIBASE) ? APIBASE : '';

let deliveryInterval = null;
let truckMarkers = {};

// ===== RENDER CONFIG FORM =====
function renderDeliveryForm() {
  const container = document.getElementById('projectRouteInfo');
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="padding:10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;">
        <div style="font-size:12px;color:#0369a1;font-weight:600;margin-bottom:4px;">📍 Full Project Corridor</div>
        <div style="font-size:11px;color:#6b7280;">
          Concrete Plant (S) → Construction Site (E)<br>
          All 92 project route segments combined
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
          <label style="font-size:12px;color:#6b7280;">Trucks/Hour</label>
          <input id="deliveryFrequency" type="number" value="12" min="1" max="30"
            style="width:100%;padding:6px;border:1px solid #e5e7eb;border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="font-size:12px;color:#6b7280;">Default Speed (km/h)</label>
          <input id="deliverySpeed" type="number" value="40" min="5" max="80"
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

// ===== START DELIVERY (uses all 92 routes) =====
async function startDelivery() {
  const body = {
    targetVolume: Number(document.getElementById('deliveryTarget').value),
    volumePerTruck: Number(document.getElementById('deliveryPerTruck').value),
    trucksPerHour: Number(document.getElementById('deliveryFrequency').value),
    defaultSpeed: Number(document.getElementById('deliverySpeed').value)
  };

  try {
    const resp = await fetch(DELIVERY_API + 'api/delivery/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert('Error: ' + (data.error || 'Unknown error'));
      return;
    }
    console.log('Delivery started:', data);

    document.getElementById('btnStartDelivery').style.display = 'none';
    document.getElementById('btnStopDelivery').style.display = 'block';

    // Start polling every 3 seconds
    pollDeliveryStatus();
    deliveryInterval = setInterval(pollDeliveryStatus, 3000);

    // Zoom to full project corridor
    if (typeof zoomToProjectRoutes === 'function') {
      zoomToProjectRoutes();
    }
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
  } catch (err) { console.error('Stop error:', err); }
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
  } catch (err) { console.error('Reset error:', err); }
}

// ===== POLL STATUS =====
async function pollDeliveryStatus() {
  try {
    const resp = await fetch(DELIVERY_API + 'api/delivery/status');
    const data = await resp.json();
    if (!data.running) return;
    updateDeliveryUI(data);
    updateTruckMarkers(data.trucks || []);
  } catch (err) {
    console.error('Poll error:', err);
  }
}

// ===== UPDATE UI =====
function updateDeliveryUI(data) {
  var p = data.progress;
  var c = data.config;
  var pct = p.percentComplete;
  var barColor = p.delayMinutes > 0 ? '#ef4444' : '#22c55e';

  document.getElementById('projectRouteInfo').innerHTML =
    '<div style="margin-bottom:12px;">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-bottom:4px;">' +
        '<span>Full Corridor (' + c.totalSegments + ' segments)</span>' +
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
      '<div><span style="color:#6b7280;">Late:</span> <b style="color:' + (p.lateTrucks > 0 ? '#ef4444' : '#22c55e') + '">' + p.lateTrucks + '</b></div>' +
    '</div>' +
    (p.delayMinutes > 0
      ? '<div style="margin-top:8px;padding:8px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:12px;color:#dc2626;">⚠️ Estimated delay: <b>' + p.delayMinutes + ' min</b></div>'
      : '') +
    '<div style="margin-top:8px;display:flex;gap:8px;">' +
      '<button onclick="stopDeliverySession()" style="flex:1;padding:6px;background:#ef4444;color:white;border:none;border-radius:4px;font-size:12px;cursor:pointer;">⏹ Stop</button>' +
      '<button onclick="resetDeliverySession()" style="padding:6px 10px;background:#6b7280;color:white;border:none;border-radius:4px;font-size:12px;cursor:pointer;">↺ Reset</button>' +
    '</div>';

  // --- Truck list ---
  var truckList = document.getElementById('projectVehicleList');
  var trucks = data.trucks || [];
  if (trucks.length === 0) {
    truckList.innerHTML = '<div style="padding:12px;color:#6b7280;font-size:13px;">No trucks dispatched yet.</div>';
  } else {
    truckList.innerHTML = trucks.map(function(t) {
      var statusColor = t.status === 'en-route' ? '#3b82f6' : (t.isLate ? '#ef4444' : '#22c55e');
      var statusIcon = t.status === 'en-route' ? '🚛' : (t.isLate ? '⚠️' : '✅');
      var etaStr = t.status === 'en-route'
        ? new Date(t.estimatedArrival).toLocaleTimeString('en-HK', { hour: '2-digit', minute: '2-digit' })
        : new Date(t.arrivalTime).toLocaleTimeString('en-HK', { hour: '2-digit', minute: '2-digit' });
      return '<div class="vehicle-item" style="border-left:3px solid ' + statusColor + ';">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span class="vehicle-item-id">' + statusIcon + ' ' + t.truckId + '</span>' +
          '<span style="font-size:11px;padding:2px 6px;border-radius:3px;background:' + statusColor + '20;color:' + statusColor + ';">' +
            (t.status === 'en-route' ? t.progress + '%' : 'Arrived') +
          '</span>' +
        '</div>' +
        '<div class="vehicle-item-eta">' +
          (t.status === 'en-route'
            ? 'Speed: ' + t.currentSpeed + ' km/h · ETA: ' + etaStr
            : 'Arrived: ' + etaStr + ' · ' + t.concreteVolume + 'm³' + (t.isLate ? ' (LATE)' : '')) +
        '</div></div>';
    }).join('');
  }

  // --- Performance panel ---
  var perfPanel = document.getElementById('projectPerformance');
  var log = data.deliveryLog || [];
  var avgTravel = log.length > 0
    ? (log.reduce(function(s, r) { return s + r.travelTimeMinutes; }, 0) / log.length).toFixed(1)
    : '-';
  var onTimeCount = log.filter(function(r) { return !r.wasLate; }).length;

  perfPanel.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">' +
      '<div><div style="color:#6b7280;font-size:11px;">Target</div><div style="font-weight:600;">' + c.targetVolume + ' m³</div></div>' +
      '<div><div style="color:#6b7280;font-size:11px;">Delivered</div><div style="font-weight:600;color:#22c55e;">' + p.delivered + ' m³</div></div>' +
      '<div><div style="color:#6b7280;font-size:11px;">Avg Travel</div><div style="font-weight:600;">' + avgTravel + ' min</div></div>' +
      '<div><div style="color:#6b7280;font-size:11px;">On Time</div><div style="font-weight:600;color:#22c55e;">' + onTimeCount + ' / ' + log.length + '</div></div>' +
    '</div>' +
    (p.delayMinutes > 0
      ? '<div style="margin-top:10px;padding:8px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;">' +
          '<div style="font-size:11px;color:#6b7280;">Projected Completion</div>' +
          '<div style="font-size:14px;font-weight:600;color:#dc2626;">' +
            (p.estimatedCompletion ? new Date(p.estimatedCompletion).toLocaleTimeString('en-HK') : 'Calculating...') +
            ' <span style="font-size:12px;font-weight:400;">(+' + p.delayMinutes + ' min delay)</span>' +
          '</div></div>'
      : (p.estimatedCompletion
          ? '<div style="margin-top:10px;padding:8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;">' +
              '<div style="font-size:11px;color:#6b7280;">Projected Completion</div>' +
              '<div style="font-size:14px;font-weight:600;color:#22c55e;">' +
                new Date(p.estimatedCompletion).toLocaleTimeString('en-HK') +
                ' <span style="font-size:12px;font-weight:400;">(on schedule)</span>' +
              '</div></div>'
          : ''));
}

// ===== TRUCK MARKERS ON MAP =====
function updateTruckMarkers(trucks) {
  var currentIds = {};
  trucks.forEach(function(t) { currentIds[t.truckId] = true; });
  Object.keys(truckMarkers).forEach(function(id) {
    if (!currentIds[id]) {
      map.removeLayer(truckMarkers[id]);
      delete truckMarkers[id];
    }
  });

  trucks.forEach(function(t) {
    if (!t.position || t.position[0] === 0) return;
    var latLng = [t.position[1], t.position[0]];
    var isArrived = t.status === 'arrived';
    var bgColor = isArrived ? (t.isLate ? '#ef4444' : '#22c55e') : '#3b82f6';
    var emoji = isArrived ? '✅' : '🚛';

    if (truckMarkers[t.truckId]) {
      truckMarkers[t.truckId].setLatLng(latLng);
      if (isArrived) {
        truckMarkers[t.truckId].setIcon(makeTruckIcon(bgColor, emoji));
      }
    } else {
      var marker = L.marker(latLng, {
        icon: makeTruckIcon(bgColor, emoji),
        zIndexOffset: 1000
      }).bindPopup(
        '<b>' + t.truckId + '</b><br>' +
        'Status: ' + t.status + '<br>' +
        'Progress: ' + t.progress + '%<br>' +
        'Speed: ' + t.currentSpeed + ' km/h<br>' +
        'Volume: ' + t.concreteVolume + ' m³'
      ).addTo(map);
      truckMarkers[t.truckId] = marker;
    }
  });
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