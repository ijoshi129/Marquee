-- What a reservation email says beyond the film and the time: the auditorium,
-- the seats, and how many tickets the order was for. And two more kinds of
-- notification to switch on or off: the reminder before a booked show, and
-- alerts from Now Playing.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS auditorium TEXT;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS seats TEXT[];
ALTER TABLE watches ADD COLUMN IF NOT EXISTS ticket_count SMALLINT;

ALTER TABLE ntfy_settings ADD COLUMN IF NOT EXISTS notify_showtime BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ntfy_settings ADD COLUMN IF NOT EXISTS notify_nowplaying BOOLEAN NOT NULL DEFAULT TRUE;
