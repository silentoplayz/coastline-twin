const R = 6371008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function makeFrame(lat0, lon0) {
  return { lat0, lon0, lat0r: lat0 * D2R, lon0r: lon0 * D2R, sinLat0: Math.sin(lat0 * D2R), cosLat0: Math.cos(lat0 * D2R) };
}

function toLatLon(frame, x, y) {
  const d = Math.hypot(x, y);
  if (d === 0) return [frame.lat0, frame.lon0];
  const c = d / R;
  const az = Math.atan2(x, y);
  const sinc = Math.sin(c), cosc = Math.cos(c);
  const sinLat = frame.sinLat0 * cosc + frame.cosLat0 * sinc * Math.cos(az);
  const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
  const lon = frame.lon0r + Math.atan2(Math.sin(az) * sinc * frame.cosLat0, cosc - frame.sinLat0 * sinLat);
  return [lat * R2D, lon * R2D];
}

function toXY(frame, lat, lon) {
  const latr = lat * D2R, dlon = lon * D2R - frame.lon0r;
  const sinLat = Math.sin(latr), cosLat = Math.cos(latr);
  const cosc = frame.sinLat0 * sinLat + frame.cosLat0 * cosLat * Math.cos(dlon);
  const c = Math.acos(Math.max(-1, Math.min(1, cosc)));
  if (c < 1e-12) return [0, 0];
  const az = Math.atan2(Math.sin(dlon) * cosLat, frame.cosLat0 * sinLat - frame.sinLat0 * cosLat * Math.cos(dlon));
  return [R * c * Math.sin(az), R * c * Math.cos(az)];
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * D2R) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

function forward(px, py, theta, flip, scale) {
  const c = Math.cos(theta * D2R), s = Math.sin(theta * D2R);
  if (flip) px = -px;
  return [scale * (c * px - s * py), scale * (s * px + c * py)];
}
