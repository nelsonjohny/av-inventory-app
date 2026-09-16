const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static HTML, JS, and CSS files directly
app.use(express.static(__dirname));

// Use the cloud database URL if available, otherwise fall back to your Neon string
const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_UpqPy86SiQwm@ep-steep-term-b3qv8b5x.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

// 1. Fetch all events for dropdowns and listings
app.get('/api/events', async (req, res) => {
  try {
    const query = `
      SELECT 
        id, 
        event_name, 
        company_name, 
        location, 
        start_date, 
        expected_return_date 
      FROM events 
      ORDER BY id DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Scan / Search Barcode
app.get('/api/scan/:barcode', async (req, res) => {
  try {
    const barcode = req.params.barcode.trim();
    const query = `
      SELECT e.*, ev.event_name, ev.expected_return_date 
      FROM equipment e
      LEFT JOIN events ev ON e.current_event_id = ev.id
      WHERE LOWER(TRIM(e.barcode)) = LOWER($1);
    `;
    const result = await pool.query(query, [barcode]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error scanning barcode:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Dispatch / Check-Out
app.post('/api/dispatch', async (req, res) => {
  const client = await pool.connect();
  try {
    const { barcode, event_id, employee_name } = req.body;
    await client.query('BEGIN');

    const equip = await client.query('SELECT id, status FROM equipment WHERE barcode = $1 FOR UPDATE', [barcode]);
    if (equip.rows.length === 0) throw new Error('Equipment barcode not found');
    if (equip.rows[0].status === 'on_hire') throw new Error('Item is already dispatched to an event!');

    const equipId = equip.rows[0].id;

    await client.query(
      "UPDATE equipment SET status = 'on_hire', current_event_id = $1 WHERE id = $2",
      [event_id, equipId]
    );

    await client.query(
      "INSERT INTO equipment_logs (equipment_id, event_id, action_type, employee_name) VALUES ($1, $2, 'DISPATCH', $3)",
      [equipId, event_id, employee_name]
    );

    await client.query('COMMIT');
    res.json({ message: 'Equipment successfully dispatched!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 4. Return / Check-In
app.post('/api/return', async (req, res) => {
  const client = await pool.connect();
  try {
    const { barcode, employee_name, condition, remarks } = req.body;
    await client.query('BEGIN');

    const equip = await client.query('SELECT id, current_event_id FROM equipment WHERE barcode = $1 FOR UPDATE', [barcode]);
    if (equip.rows.length === 0) throw new Error('Equipment barcode not found');

    const equipId = equip.rows[0].id;
    const currentEventId = equip.rows[0].current_event_id;

    const newStatus = condition === 'damaged' ? 'maintenance' : 'available';

    await client.query(
      'UPDATE equipment SET status = $1, condition = $2, remarks = $3, current_event_id = NULL WHERE id = $4',
      [newStatus, condition, remarks, equipId]
    );

    await client.query(
      "INSERT INTO equipment_logs (equipment_id, event_id, action_type, employee_name, condition, remarks) VALUES ($1, $2, 'RETURN', $3, $4, $5)",
      [equipId, currentEventId, employee_name, condition, remarks]
    );

    await client.query('COMMIT');
    res.json({ message: 'Equipment successfully checked in!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5. Report: Overdue Equipment Alerts
app.get('/api/reports/overdue', async (req, res) => {
  try {
    const query = `
      SELECT 
        e.barcode,
        e.model_name,
        e.category,
        ev.event_name,
        COALESCE(ev.company_name, ev.client_name, 'N/A') AS company_name,
        ev.expected_return_date,
        ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ev.expected_return_date)) / 3600)::INT AS hours_overdue,
        COALESCE(
          (SELECT employee_name FROM equipment_logs WHERE equipment_id = e.id AND action_type = 'DISPATCH' ORDER BY action_timestamp DESC LIMIT 1),
          'Not logged'
        ) AS dispatched_by
      FROM equipment e
      JOIN events ev ON e.current_event_id = ev.id
      WHERE e.status = 'on_hire' 
        AND ev.expected_return_date < CURRENT_TIMESTAMP
      ORDER BY ev.expected_return_date ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/reports/overdue:', err);
    res.status(500).json({ error: err.message });
  }
});

// 6. Report: 7-Day Equipment Activity & Utilization Summary
app.get('/api/reports/weekly-summary', async (req, res) => {
  try {
    const kpiQuery = `
      SELECT
        (SELECT COUNT(*) FROM equipment) AS total_inventory,
        (SELECT COUNT(*) FROM equipment WHERE status = 'available') AS available_count,
        (SELECT COUNT(*) FROM equipment WHERE status = 'on_hire') AS on_hire_count,
        (SELECT COUNT(*) FROM equipment WHERE status = 'maintenance') AS maintenance_count,
        (SELECT COUNT(*) FROM equipment_logs WHERE action_timestamp >= CURRENT_TIMESTAMP - INTERVAL '7 days') AS weekly_movements,
        (SELECT COUNT(*) FROM equipment_logs WHERE action_type = 'RETURN' AND condition = 'damaged' AND action_timestamp >= CURRENT_TIMESTAMP - INTERVAL '7 days') AS weekly_damages;
    `;
    const kpiResult = await pool.query(kpiQuery);

    const logsQuery = `
      SELECT 
        l.action_type,
        l.employee_name,
        l.action_timestamp,
        l.condition,
        l.remarks,
        e.barcode,
        e.model_name,
        ev.event_name
      FROM equipment_logs l
      JOIN equipment e ON l.equipment_id = e.id
      LEFT JOIN events ev ON l.event_id = ev.id
      WHERE l.action_timestamp >= CURRENT_TIMESTAMP - INTERVAL '7 days'
      ORDER BY l.action_timestamp DESC
      LIMIT 25;
    `;
    const logsResult = await pool.query(logsQuery);

    res.json({
      kpis: kpiResult.rows[0],
      recentActivity: logsResult.rows
    });
  } catch (err) {
    console.error('Error fetching weekly summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// 7. Inventory: Add New Equipment
app.post('/api/equipment', async (req, res) => {
  try {
    const { barcode, model_name, category } = req.body;

    if (!barcode || !model_name || !category) {
      return res.status(400).json({ error: 'Barcode, model name, and category are required.' });
    }

    const query = `
      INSERT INTO equipment (barcode, model_name, category, status, condition)
      VALUES ($1, $2, $3, 'available', 'excellent')
      RETURNING *;
    `;
    const result = await pool.query(query, [barcode.trim().toUpperCase(), model_name.trim(), category]);

    res.status(201).json({
      message: 'Equipment registered successfully!',
      item: result.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'An item with this barcode already exists!' });
    }
    console.error('Error adding equipment:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. Inventory: Fetch All Equipment
app.get('/api/equipment', async (req, res) => {
  try {
    const query = `
      SELECT 
        e.id,
        e.barcode,
        e.model_name,
        e.category,
        e.status,
        e.condition,
        e.remarks,
        ev.event_name
      FROM equipment e
      LEFT JOIN events ev ON e.current_event_id = ev.id
      ORDER BY e.category ASC, e.model_name ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching inventory list:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8.1 Inventory: Update Equipment Details & Maintenance Status
app.put('/api/equipment/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { model_name, category, status, condition, remarks, employee_name } = req.body;

    if (!model_name || !category || !status) {
      return res.status(400).json({ error: 'Model name, category, and status are required.' });
    }

    await client.query('BEGIN');

    // Fixed: explicitly cast NULL to INT so PostgreSQL knows parameter types
    const updateQuery = `
      UPDATE equipment 
      SET 
        model_name = $1,
        category = $2,
        status = $3,
        condition = $4,
        remarks = $5,
        current_event_id = CASE 
          WHEN $3 IN ('available', 'maintenance') THEN NULL::INT 
          ELSE current_event_id 
        END
      WHERE id = $6::INT
      RETURNING *;
    `;
    const updateRes = await client.query(updateQuery, [
      model_name.trim(),
      category.trim(),
      status,
      condition || 'good',
      remarks || null,
      id
    ]);

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Equipment not found' });
    }

    // Log the maintenance or edit action
    await client.query(
      `INSERT INTO equipment_logs (equipment_id, action_type, employee_name, condition, remarks) 
       VALUES ($1::INT, $2, $3, $4, $5)`,
      [
        id, 
        status === 'maintenance' ? 'MAINTENANCE_IN' : 'EDIT_UPDATE', 
        employee_name || 'Technician', 
        condition, 
        remarks || (status === 'maintenance' ? 'Marked for repair' : 'Item updated')
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Equipment updated successfully!', item: updateRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating equipment:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});



// 9. POST /api/events - Create new event/job
app.post('/api/events', async (req, res) => {
  try {
    const { event_name, company_name, location, start_date, expected_return_date } = req.body;

    if (!event_name || !expected_return_date) {
      return res.status(400).json({ error: 'Event name and expected return date are required.' });
    }

    const query = `
      INSERT INTO events (event_name, company_name, location, start_date, expected_return_date)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const values = [
      event_name.trim(),
      company_name ? company_name.trim() : null,
      location ? location.trim() : null,
      start_date || new Date().toISOString().split('T')[0],
      expected_return_date
    ];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating event:', err);
    res.status(500).json({ error: err.message });
  }
});

// 10. GET /api/events/:id/equipment - Fetch items assigned or returned for an event
app.get('/api/events/:id/equipment', async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT DISTINCT 
        e.id,
        e.barcode,
        e.model_name,
        e.category,
        e.condition,
        CASE 
          WHEN e.current_event_id = $1 THEN 'ON_HIRE'
          ELSE 'RETURNED'
        END AS event_equipment_status
      FROM equipment e
      WHERE e.current_event_id = $1
         OR e.id IN (
           SELECT equipment_id 
           FROM equipment_logs 
           WHERE event_id = $1
         )
      ORDER BY event_equipment_status ASC, e.model_name ASC;
    `;

    const result = await pool.query(query, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching event equipment:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
