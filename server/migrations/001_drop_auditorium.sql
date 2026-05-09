-- Drop the auditorium column. The reservation parser used to extract this
-- from AMC emails but the UI never surfaced it; data was accumulating dead.
ALTER TABLE watches DROP COLUMN IF EXISTS auditorium;
