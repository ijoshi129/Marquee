const { pool } = require('../db');
const { normalizeText } = require('../utils/normalize');

async function upsertTheater(name) {
  if (!name || !name.trim()) return null;
  const normalized = normalizeText(name);
  const result = await pool.query(
    `INSERT INTO theaters (name, normalized_name)
     VALUES ($1, $2)
     ON CONFLICT (normalized_name) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [name.trim(), normalized]
  );
  return result.rows[0];
}

async function searchTheaters(query) {
  if (!query) {
    const all = await pool.query('SELECT * FROM theaters ORDER BY name LIMIT 20');
    return all.rows;
  }
  const normalized = normalizeText(query);
  const result = await pool.query(
    `SELECT * FROM theaters
     WHERE normalized_name LIKE $1
     ORDER BY name
     LIMIT 20`,
    [`%${normalized}%`]
  );
  return result.rows;
}

module.exports = { upsertTheater, searchTheaters };
