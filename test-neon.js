const { Pool } = require('pg');

// PASTE YOUR FULL NEON CONNECTION STRING INSIDE THE QUOTES BELOW:
const connectionString = 'postgresql://neondb_owner:npg_UpqPy86SiQwm@ep-steep-term-b3qv8b5x.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function runSetup() {
  console.log('Connecting to Neon cloud database...');
  try {
    const client = await pool.connect();
    console.log('✅ Connected successfully!');

    // Create tables
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS events (
          id SERIAL PRIMARY KEY,
          event_name VARCHAR(150) NOT NULL,
          client_name VARCHAR(100),
          expected_return_date TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS equipment (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          barcode VARCHAR(50) UNIQUE NOT NULL,
          model_name VARCHAR(150) NOT NULL,
          category VARCHAR(50) NOT NULL,
          status VARCHAR(20) DEFAULT 'available',
          condition VARCHAR(50) DEFAULT 'excellent',
          remarks TEXT,
          current_event_id INT REFERENCES events(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS equipment_logs (
          id SERIAL PRIMARY KEY,
          equipment_id UUID NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
          event_id INT REFERENCES events(id) ON DELETE SET NULL,
          action_type VARCHAR(20) NOT NULL,
          employee_name VARCHAR(100) NOT NULL,
          action_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          condition VARCHAR(50),
          remarks TEXT
      );

      INSERT INTO events (event_name, client_name, expected_return_date)
      VALUES 
        ('Annual Corporate Meet', 'Vertex Media', CURRENT_TIMESTAMP + INTERVAL '3 days'),
        ('Sound & Light Expo', 'Nexus Live', CURRENT_TIMESTAMP - INTERVAL '2 days')
      ON CONFLICT DO NOTHING;

      INSERT INTO equipment (barcode, model_name, category, status, condition)
      VALUES 
        ('AV-CAM-001', 'Sony FX3 Cinema Camera', 'Video', 'available', 'excellent'),
        ('AV-MIC-101', 'Shure SM58 Dynamic Mic', 'Audio', 'available', 'good'),
        ('AV-LGT-201', 'Aputure 300d II LED Light', 'Lighting', 'available', 'excellent')
      ON CONFLICT DO NOTHING;
    `);

    console.log('✅ All tables and seed data created successfully in Neon!');
    client.release();
    process.exit(0);
  } catch (err) {
    console.error('❌ Connection or query error:', err.message);
    process.exit(1);
  }
}

runSetup();