// ========================================
// delivery.js v3 — Throughput-based tracking
// ========================================
var DELIVERY_API = (typeof APIBASE !== 'undefined' && APIBASE) ? APIBASE : '';

let deliveryInterval = null;
let truckMarkers = {};
let lastNonEmptyTrucks = [];
let lastNonEmptyTruckList = [];


// ===== RENDER CONFIG FORM =====
function renderDeliveryForm() {
  const container = document.getElementById('projectRouteInfo');
  container.innerHTML = 'Waiting for live delivery data...';
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
    deliveryInterval = setInterval(pollDeliveryStatus, 1000);

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
let lastGoodStatus = null;

async function pollDeliveryStatus() {
  try {
    const resp = await fetch(DELIVERY_API + "/api/delivery/status");
    if (!resp.ok) throw new Error("HTTP " + resp.status);

    const data = await resp.json();

    if (!data.running || !data.config || !data.progress) {
      // Session not running: do nothing; UI keeps last state.
      console.log("Delivery session not running");
      return;
    }

    updateDeliveryUI(data);
    updateTruckMarkers(data.trucks || []);
  } catch (err) {
    console.error("Poll error", err);
    // On error we keep last UI and markers; do NOT call updateDeliveryUI / updateTruckMarkers.
  }
}

// ===== UPDATE UI =====
function updateDeliveryUI(data) {
  var p  = data.progress;
  var c  = data.config;
  var tp = data.throughput;
  var pct = p.percentComplete;
  var barColor = tp.behindSchedule ? '#ef4444' : '#22c55e';

  // mark card as active
  var overviewCard = document.querySelector('#projectPanel .eta-info');
  if (overviewCard) {
    overviewCard.classList.add('active');
    overviewCard.classList.remove('inactive');
  }

  // --- Concrete Delivery Overview (no corridor text, no buttons) ---
  var warningHtml = '';
  if (tp.behindSchedule) {
    warningHtml =
      '<div style="margin-top:8px;padding:8px;background:#fef2f2;border:1px solid #fecaca;' +
      'border-radius:6px;font-size:12px;color:#dc2626;">' +
        '⚠️ Behind schedule: <b>' + tp.windowActual + '/' + tp.windowTarget + '</b> trucks this hour' +
        (tp.delayMinutes > 0 ? ' · Projected delay: <b>+' + tp.delayMinutes + ' min</b>' : '') +
      '</div>';
  } else if (tp.actualRate > 0) {
    warningHtml =
      '<div style="margin-top:8px;padding:8px;background:#022c22;border:1px solid #16a34a;' +
      'border-radius:6px;font-size:12px;color:#bbf7d0;">' +
        '✅ On schedule this hour' +
      '</div>';
  }

  document.getElementById('projectRouteInfo').innerHTML =
    '<div style="margin-bottom:10px;font-size:12px;color:#9ca3af;">' +
      'Daily target: <b>' + c.targetVolume + ' m³</b> · Delivered: <b>' + p.delivered + ' m³</b>' +
    '</div>' +
    '<div style="background:#1f2937;border-radius:999px;height:18px;overflow:hidden;">' +
      '<div style="background:' + barColor + ';height:100%;width:' + pct + '%;' +
      'border-radius:999px;transition:width 0.5s;display:flex;align-items:center;' +
      'justify-content:center;color:white;font-size:11px;font-weight:600;">' +
        pct + '%' +
      '</div>' +
    '</div>' +
    warningHtml;

  // --- Performance panel (bottom / timeline) ---
  var perfPanel = document.getElementById('projectPerformance');
  var log = data.deliveryLog || [];
  var avgTravel = log.length > 0
    ? (log.reduce(function (s, r) { return s + r.travelTimeMinutes; }, 0) / log.length).toFixed(1)
    : '-';

  var summaryHtml =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">' +
      '<div>' +
        '<div style="color:#9ca3af;font-size:11px;">En route</div>' +
        '<div style="font-weight:600;">' + p.trucksEnRoute + '</div>' +
      '</div>' +
      '<div>' +
        '<div style="color:#9ca3af;font-size:11px;">Arrived</div>' +
        '<div style="font-weight:600;">' + p.trucksCompleted + '</div>' +
      '</div>' +
    '</div>';


  if (p.estimatedCompletion) {
    summaryHtml +=
      '<div style="margin-top:10px;padding:8px;background:' + (tp.behindSchedule ? '#fef2f2' : '#f0fdf4') +
      ';border:1px solid ' + (tp.behindSchedule ? '#fecaca' : '#bbf7d0') + ';border-radius:6px;">' +
        '<div style="font-size:11px;color:#6b7280;">Projected Completion</div>' +
        '<div style="font-size:14px;font-weight:600;color:' + (tp.behindSchedule ? '#dc2626' : '#22c55e') + ';">' +
          new Date(p.estimatedCompletion).toLocaleTimeString('en-HK') +
          (tp.delayMinutes > 0
            ? ' <span style="font-size:12px;font-weight:400;">(+' + tp.delayMinutes + ' min delay)</span>'
            : ' <span style="font-size:12px;font-weight:400;">(on schedule)</span>') +
        '</div>' +
      '</div>';
  }

  // Optionally keep your old hourly text list under the cards
  var hourlyHtml = '';
  if (tp.hourlyBreakdown && tp.hourlyBreakdown.length > 0) {
    hourlyHtml = '<div style="margin-top:10px;border-top:1px solid #e5e7eb;padding-top:8px;">' +
      '<div style="font-size:11px;color:#6b7280;margin-bottom:6px;font-weight:600;">Hourly Throughput</div>';
    tp.hourlyBreakdown.forEach(function (h) {
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
  var timelineHtml = buildPerformanceTimeline(tp, p);

  if (perfPanel) {
    perfPanel.innerHTML = summaryHtml + hourlyHtml + timelineHtml;
  }

  // --- Truck list (active concrete vehicles) ---
  var truckList = document.getElementById('projectVehicleList');
  var trucks = data.trucks || [];   // <-- this line is required

  if (trucks.length === 0) {
    truckList.innerHTML =
      '<div style="padding:12px;color:#6b7280;font-size:13px;">No trucks dispatched yet.</div>';
  } else {
    truckList.innerHTML = trucks.map(function (t) {
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
}

function buildPerformanceTimeline(tp, progress) {
  var startHour = 8;
  var endHour = 23;

  if (progress && progress.estimatedCompletion) {
    var eta = new Date(progress.estimatedCompletion);
    var etaHour = eta.getHours();
    if (etaHour > endHour) endHour = etaHour;
  }

  var breakdownMap = {};
  if (tp.hourlyBreakdown && tp.hourlyBreakdown.length) {
    tp.hourlyBreakdown.forEach(function (h) {
      breakdownMap[h.hour] = h;
    });
  }

  function buildRow(label, type) {
    var totalHours = endHour - startHour + 1;
    var rowHtml = '<div class="timeline-row">' +
      '<div class="timeline-label">' + label + '</div>' +
      '<div class="timeline-track">';

    for (var h = startHour; h <= endHour; h++) {
      var info = breakdownMap[h] || { target: tp.targetRate || 0, actual: 0 };
      var widthPct = (1 / totalHours) * 100;

      if (type === 'planned') {
        rowHtml +=
          '<div class="timeline-hour planned" ' +
          'style="left:' + ((h - startHour) / totalHours * 100) +
          '%;width:' + widthPct + '%;">' +
          (info.target || tp.targetRate || 0) +
          '</div>';
      } else {
        var cls = info.actual >= info.target ? 'actual-ok' : 'actual-miss';
        var text = (info.actual || 0) + '/' + (info.target || tp.targetRate || 0);
        rowHtml +=
          '<div class="timeline-hour ' + cls + '" ' +
          'style="left:' + ((h - startHour) / totalHours * 100) +
          '%;width:' + widthPct + '%;">' +
          text +
          '</div>';
      }
    }

    var now = new Date();
    var nowHour = now.getHours() + now.getMinutes() / 60;
    if (nowHour >= startHour && nowHour <= endHour) {
      var posPct = ((nowHour - startHour) / (endHour - startHour)) * 100;
      rowHtml +=
        '<div class="timeline-current" style="left:' + posPct + '%;"></div>';
    }

    rowHtml += '</div></div>';
    return rowHtml;
  }

  var html = '';
  html += buildRow('Planned', 'planned');
  html += buildRow('Actual', 'actual');
  return html;
}


// ===== TRUCK MARKERS =====


function updateTruckMarkers(trucks) {
  // Trust the backend: if trucks is empty, remove all markers.
  var list = trucks || [];

  var currentIds = {};
  list.forEach(function (t) {
    currentIds[t.truckId] = true;
  });

  Object.keys(truckMarkers).forEach(function (id) {
    if (!currentIds[id]) {
      map.removeLayer(truckMarkers[id]);
      delete truckMarkers[id];
    }
  });

  list.forEach(function (t) {
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