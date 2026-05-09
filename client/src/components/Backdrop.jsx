import { useEffect, useRef, useState } from 'react';

// Plex-style ambient backdrop. A heavily blurred poster image fills the viewport
// behind everything, fading vertically into the base bg. Cross-fades when the
// poster source changes — keeps two layers around until the new one's settled.
export default function Backdrop({ posterUrl, intensity = 'ambient' }) {
  const [layers, setLayers] = useState(() =>
    posterUrl ? [{ url: posterUrl, key: 1 }] : []
  );
  const nextKey = useRef(2);

  useEffect(() => {
    setLayers((current) => {
      const top = current[current.length - 1];
      if (top && top.url === posterUrl) return current;
      if (!posterUrl) {
        const placeholder = { url: null, key: nextKey.current++ };
        return [...current.slice(-1), placeholder];
      }
      const fresh = { url: posterUrl, key: nextKey.current++ };
      return [...current.slice(-1), fresh];
    });
  }, [posterUrl]);

  useEffect(() => {
    if (layers.length < 2) return;
    const t = setTimeout(() => {
      setLayers((ls) => ls.slice(-1));
    }, 1400);
    return () => clearTimeout(t);
  }, [layers]);

  return (
    <div className={`backdrop intensity-${intensity}`} aria-hidden="true">
      {layers.map((l, i) => (
        <div
          key={l.key}
          className={`backdrop-layer ${i === layers.length - 1 ? 'active' : 'fading'}`}
          style={l.url ? { backgroundImage: `url(${l.url})` } : undefined}
        />
      ))}
      <div className="backdrop-vignette" />
      <div className="backdrop-grain" />
    </div>
  );
}
