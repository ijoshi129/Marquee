async function request(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.json()).error || '';
    } catch {}
    throw new Error(body || `HTTP ${res.status}`);
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
};
