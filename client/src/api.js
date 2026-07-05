const PASSCODE_KEY = 'marquee.passcode';

export function setStoredPasscode(code) {
  try {
    if (code) localStorage.setItem(PASSCODE_KEY, code);
    else localStorage.removeItem(PASSCODE_KEY);
  } catch {}
}
function storedPasscode() {
  try {
    return localStorage.getItem(PASSCODE_KEY);
  } catch {
    return null;
  }
}

// The app registers a handler so a mid-session lock (a stale/rotated passcode
// causing a 401) re-shows the Unlock gate instead of stranding the user on
// error banners with no way back.
let lockedHandler = null;
export function onLocked(fn) {
  lockedHandler = fn;
}

async function request(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const pass = storedPasscode();
  if (pass) headers['X-Owner-Passcode'] = pass;

  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    let body = '';
    let locked = false;
    try {
      const j = await res.json();
      body = j.error || '';
      locked = !!j.locked;
    } catch {}
    const err = new Error(body || `HTTP ${res.status}`);
    if (res.status === 401 && locked) {
      err.locked = true;
      // The stored passcode is no longer accepted — drop it and re-gate.
      setStoredPasscode(null);
      lockedHandler?.();
    }
    throw err;
  }
  return res.json();
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

export const api = {
  listWatches: (params = {}) => request(`/api/watches${qs(params)}`),
  getWatch: (id) => request(`/api/watches/${id}`),
  createWatch: (body) =>
    request('/api/watches', { method: 'POST', body: JSON.stringify(body) }),
  updateWatch: (id, body) =>
    request(`/api/watches/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteWatch: (id) => request(`/api/watches/${id}`, { method: 'DELETE' }),
  recheckUnseen: (id) => request(`/api/watches/${id}/recheck-unseen`, { method: 'POST' }),
  searchTmdb: (q) => request(`/api/tmdb/search?q=${encodeURIComponent(q)}`),
  searchTheaters: (q) => request(`/api/theaters?q=${encodeURIComponent(q || '')}`),
  stats: (params = {}) => request(`/api/stats${qs(params)}`),
  notifications: () => request('/api/watches/notifications'),
  searchSuggest: (q) => request(`/api/search-suggest?q=${encodeURIComponent(q || '')}`),
  tags: () => request('/api/tags'),
  listWatchlist: () => request('/api/watchlist'),
  addWatchlist: (tmdb_id) =>
    request('/api/watchlist', { method: 'POST', body: JSON.stringify({ tmdb_id }) }),
  removeWatchlist: (id) => request(`/api/watchlist/${id}`, { method: 'DELETE' }),
  markWatchlistWatched: (id, body = {}) =>
    request(`/api/watchlist/${id}/watched`, { method: 'POST', body: JSON.stringify(body) }),
  nowPlaying: () => request('/api/watchlist/now-playing'),
  alistMembership: () => request('/api/alist-membership'),
  setAlistMembership: (year, has_alist) =>
    request(`/api/alist-membership/${year}`, {
      method: 'PUT',
      body: JSON.stringify({ has_alist }),
    }),
  setAlistMembershipMonth: (year, month, has_alist) =>
    request(`/api/alist-membership/${year}/${month}`, {
      method: 'PUT',
      body: JSON.stringify({ has_alist }),
    }),
  alerts: () => request('/api/notifications'),
  markAlertsRead: () => request('/api/notifications/read', { method: 'POST' }),
  markAlertRead: (id) => request(`/api/notifications/${id}/read`, { method: 'POST' }),
  deleteAlert: (id) => request(`/api/notifications/${id}`, { method: 'DELETE' }),
  clearAlerts: () => request('/api/notifications', { method: 'DELETE' }),
  pushKey: () => request('/api/push/key'),
  subscribePush: (subscription) =>
    request('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }),
  unsubscribePush: (endpoint) =>
    request('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  ntfySettings: () => request('/api/ntfy'),
  setNtfySettings: (body) => request('/api/ntfy', { method: 'PUT', body: JSON.stringify(body) }),
  testNtfy: (body) => request('/api/ntfy/test', { method: 'POST', body: JSON.stringify(body) }),
  friends: () => request('/api/friends'),
  friendsFeed: () => request('/api/friends/feed'),
  inviteFriend: () => request('/api/friends/invite', { method: 'POST' }),
  acceptFriend: (invite) =>
    request('/api/friends/accept', { method: 'POST', body: JSON.stringify({ invite }) }),
  removeFriend: (id) => request(`/api/friends/${id}`, { method: 'DELETE' }),
  commentOnWatch: (friendId, remote_watch_id, text) =>
    request(`/api/friends/${friendId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ remote_watch_id, text }),
    }),
  commentOnOwnWatch: (watchId, text) =>
    request(`/api/watches/${watchId}/comment`, { method: 'POST', body: JSON.stringify({ text }) }),
  recommendFilm: (friendId, tmdb_id, title) =>
    request(`/api/friends/${friendId}/recommend`, {
      method: 'POST',
      body: JSON.stringify({ tmdb_id, title }),
    }),
  recommendations: () => request('/api/recommendations'),
  addRecommendation: (id) => request(`/api/recommendations/${id}/add`, { method: 'POST' }),
  dismissRecommendation: (id) => request(`/api/recommendations/${id}/dismiss`, { method: 'POST' }),
  friendWatches: (id) => request(`/api/friends/${id}/watches`),
  friendProfile: (id) => request(`/api/friends/${id}/profile`),
  commonFilms: (id) => request(`/api/friends/${id}/common`),
  syncFriends: () => request('/api/friends/sync-now', { method: 'POST' }),
  syncFriend: (id) => request(`/api/friends/${id}/sync`, { method: 'POST' }),
  testConnection: (id) => request(`/api/friends/${id}/test-connection`, { method: 'POST' }),
  federationSettings: () => request('/api/friends/settings'),
  setFederationSettings: (body) =>
    request('/api/friends/settings', { method: 'PUT', body: JSON.stringify(body) }),
  authStatus: () => request('/api/auth/status'),
  unlock: (passcode) =>
    request('/api/auth/unlock', { method: 'POST', body: JSON.stringify({ passcode }) }),
};
