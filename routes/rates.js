// backend/routes/rates.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/*
  Tables assumed:
    scrap_types (id, material_type, global_rate, last_updated)
    vendors (id, name, vendor_type, created_at)
    vendor_rates (id, vendor_id, scrap_type_id, vendor_rate, rate_offset)
*/

/* --------------------------------------------------------
   ADD NEW SCRAP MATERIAL
-------------------------------------------------------- */
router.post("/add-material", async (req, res) => {
  try {
    const { material_type, base_rate } = req.body;
    if (!material_type || base_rate == null) {
      return res.status(400).json({ error: "material_type and base_rate required" });
    }

    const result = await pool.query(
      `INSERT INTO scrap_types (id, material_type, global_rate, last_updated)
       VALUES (uuid_generate_v4(), $1, $2, NOW())
       RETURNING *`,
      [material_type, base_rate]
    );

    res.json({ success: true, material: result.rows[0] });
  } catch (err) {
    console.error("❌ add-material:", err);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------------
   GET ALL GLOBAL MATERIAL RATES
-------------------------------------------------------- */
router.get("/global", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM scrap_types ORDER BY material_type ASC
    `);
    res.json({ success: true, materials: result.rows });
  } catch (err) {
    console.error("❌ get-global:", err);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------------
   UPDATE GLOBAL RATE + ADJUST ALL VENDOR RATES
-------------------------------------------------------- */
router.post("/update-global", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scrap_type_id, new_global_rate } = req.body;

    if (!scrap_type_id || new_global_rate == null) {
      return res.status(400).json({ error: "scrap_type_id and new_global_rate required" });
    }

    await client.query("BEGIN");

    const updateGlobal = await client.query(
      `UPDATE scrap_types
       SET global_rate = $1, last_updated = NOW()
       WHERE id = $2
       RETURNING *`,
      [new_global_rate, scrap_type_id]
    );

    if (updateGlobal.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "scrap_type not found" });
    }

    const vendorRates = await client.query(
      `SELECT id, vendor_id, rate_offset 
       FROM vendor_rates 
       WHERE scrap_type_id = $1`,
      [scrap_type_id]
    );

    const updatedVendors = [];
    for (const v of vendorRates.rows) {
      const new_vendor_rate = Number(new_global_rate) + Number(v.rate_offset || 0);

      await client.query(
        `UPDATE vendor_rates 
         SET vendor_rate = $1 
         WHERE id = $2`,
        [new_vendor_rate, v.id]
      );

      updatedVendors.push({
        vendor_rate_id: v.id,
        vendor_id: v.vendor_id,
        new_vendor_rate,
        rate_offset: v.rate_offset
      });
    }

    await client.query("COMMIT");
    res.json({
      success: true,
      updatedGlobal: updateGlobal.rows[0],
      affectedVendors: updatedVendors
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ update-global:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* --------------------------------------------------------
   ADD NEW VENDOR
-------------------------------------------------------- */
router.post("/add-vendor", async (req, res) => {
  try {
    const { name, vendor_type } = req.body;
    if (!name || !vendor_type) {
      return res.status(400).json({ error: "name and vendor_type required" });
    }

    const v = await pool.query(
      `INSERT INTO vendors (id, name, vendor_type, created_at)
       VALUES (uuid_generate_v4(), $1, $2, NOW())
       RETURNING *`,
      [name, vendor_type]
    );

    res.json({ success: true, vendor: v.rows[0] });
  } catch (err) {
    console.error("❌ add-vendor:", err);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------------
   SET VENDOR RATE
-------------------------------------------------------- */
router.post("/set-vendor-rate", async (req, res) => {
  try {
    const { vendor_id, scrap_type_id, vendor_rate } = req.body;

    if (!vendor_id || !scrap_type_id || vendor_rate == null) {
      return res.status(400).json({
        error: "vendor_id, scrap_type_id, vendor_rate required"
      });
    }

    const globalRateRes = await pool.query(
      `SELECT global_rate FROM scrap_types WHERE id = $1`,
      [scrap_type_id]
    );

    if (globalRateRes.rowCount === 0) {
      return res.status(404).json({ error: "material not found" });
    }

    const rate_offset =
      Number(vendor_rate) - Number(globalRateRes.rows[0].global_rate);

    const inserted = await pool.query(
      `INSERT INTO vendor_rates (id, vendor_id, scrap_type_id, vendor_rate, rate_offset)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4)
       ON CONFLICT (vendor_id, scrap_type_id) DO UPDATE
       SET vendor_rate = EXCLUDED.vendor_rate,
           rate_offset = EXCLUDED.rate_offset
       RETURNING *`,
      [vendor_id, scrap_type_id, vendor_rate, rate_offset]
    );

    res.json({ success: true, vendorRate: inserted.rows[0] });
  } catch (err) {
    console.error("❌ set-vendor-rate:", err);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------------
   UPDATE VENDOR RATE
-------------------------------------------------------- */
router.post("/update-vendor", async (req, res) => {
  try {
    const { vendor_id, scrap_type_id, new_vendor_rate } = req.body;
    if (!vendor_id || !scrap_type_id || new_vendor_rate == null) {
      return res.status(400).json({
        error: "vendor_id, scrap_type_id, new_vendor_rate required"
      });
    }

    const globalRateRes = await pool.query(
      `SELECT global_rate FROM scrap_types WHERE id = $1`,
      [scrap_type_id]
    );

    if (globalRateRes.rowCount === 0) {
      return res.status(404).json({ error: "material not found" });
    }

    const rate_offset =
      Number(new_vendor_rate) - Number(globalRateRes.rows[0].global_rate);

    const updated = await pool.query(
      `UPDATE vendor_rates
       SET vendor_rate = $1, rate_offset = $2
       WHERE vendor_id = $3 AND scrap_type_id = $4
       RETURNING *`,
      [new_vendor_rate, rate_offset, vendor_id, scrap_type_id]
    );

    res.json({ success: true, vendorRate: updated.rows[0] });
  } catch (err) {
    console.error("❌ update-vendor:", err);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------------
   GET ALL VENDORS WITH THEIR RATES
-------------------------------------------------------- */
router.get("/vendors-with-rates", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        v.id AS vendor_id,
        v.name AS vendor_name,
        v.vendor_type,
        vr.id AS rate_id,
        vr.scrap_type_id,
        st.material_type AS scrap_type,
        vr.vendor_rate,
        vr.rate_offset
      FROM vendors v
      LEFT JOIN vendor_rates vr ON vr.vendor_id = v.id
      LEFT JOIN scrap_types st ON st.id = vr.scrap_type_id
      ORDER BY v.name ASC, st.material_type ASC
    `);

    const map = {};
    result.rows.forEach((r) => {
      if (!map[r.vendor_id]) {
        map[r.vendor_id] = {
          vendor_id: r.vendor_id,
          vendor_name: r.vendor_name,
          type: r.vendor_type,
          rates: []
        };
      }
      if (r.scrap_type_id) {
        map[r.vendor_id].rates.push({
          scrap_type_id: r.scrap_type_id,
          scrap_type: r.scrap_type,
          vendor_rate: r.vendor_rate,
          rate_offset: r.rate_offset
        });
      }
    });

    res.json({ success: true, vendors: Object.values(map) });
  } catch (err) {
    console.error("❌ vendors-with-rates:", err);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------------
   DELETE MATERIAL
-------------------------------------------------------- */
router.delete("/delete-material/:scrap_type_id", async (req, res) => {
  try {
    const { scrap_type_id } = req.params;

    await pool.query(
      "DELETE FROM vendor_rates WHERE scrap_type_id = $1",
      [scrap_type_id]
    );

    const deleted = await pool.query(
      "DELETE FROM scrap_types WHERE id = $1 RETURNING *",
      [scrap_type_id]
    );

    if (deleted.rowCount === 0) {
      return res.status(404).json({ error: "Material not found" });
    }

    res.json({ success: true, message: "Material deleted" });
  } catch (err) {
    console.error("❌ delete-material:", err);
    res.status(500).json({ error: "Failed to delete material" });
  }
});

/* --------------------------------------------------------
   DELETE VENDOR
-------------------------------------------------------- */
router.delete("/delete-vendor/:vendor_id", async (req, res) => {
  try {
    const { vendor_id } = req.params;

    await pool.query(
      "DELETE FROM vendor_rates WHERE vendor_id = $1",
      [vendor_id]
    );

    const deleted = await pool.query(
      "DELETE FROM vendors WHERE id = $1 RETURNING *",
      [vendor_id]
    );

    if (deleted.rowCount === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    res.json({ success: true, message: "Vendor deleted" });
  } catch (err) {
    console.error("❌ delete-vendor:", err);
    res.status(500).json({ error: "Failed to delete vendor" });
  }
});

export default router;
