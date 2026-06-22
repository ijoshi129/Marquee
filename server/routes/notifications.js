const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');

const router = express.Router();

// GET /api/notifications — recent notifications + unread count.
router.get('/', async (req, res) => {
  try {
    const [list, unread] = await Promise.all([
      pool.query(
        `SELECT id, kind, title, body, payload, read_at, created_at
           FROM notifications ORDER BY created_at DESC LIMIT 50`
      ),
      pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE read_at IS NULL'),
    ]);
    res.json({ items: list.rows, unread: unread.rows[0].n });
  } catch (err) {
    logger.error({ err }, 'list notifications');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/read — mark all as read.
router.post('/read', async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'mark notifications read');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/notifications — clear all.
router.delete('/', async (req, res) => {
  try {
    await pool.query('DELETE FROM notifications');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'clear notifications');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/:id/read — mark one as read.
router.post('/:id/read', async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'mark notification read');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/notifications/:id — dismiss one.
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM notifications WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'delete notification');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
