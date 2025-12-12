// backend/routes/maalin.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* ==========================================================
   1. CREATE MAAL_IN HEADER   (Manager Step 1)
   ========================================================== */
router.post("/", async (req, res) => {
  try {
    const {
      company_id,
      godown_id,
      date,
      supplier_name,
      source,
      vehicle_number,
      notes,
      created_by
    } = req.body;

    if (!company_id || !godown_id || !supplier_name || !date) {
      return res.status(400).json({
        success: false,
        error: "company_id, godown_id, supplier_name and date are required"
      });
    }

    const q = `
      INSERT INTO maal_in
      (company_id, godown_id, date, supplier_name, source, vehicle_number, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *;
    `;

    const result = await pool.query(q, [
      company_id,
      godown_id,
      date,
      supplier_name,
      source || "kabadiwala",
      vehicle_number || null,
      notes || null,
      created_by || "manager"
    ]);

    return res.status(201).json({
      success: true,
      maal_in: result.rows[0]
    });

  } catch (err) {
    console.error("❌ MaalIn Header Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


/* ==========================================================
   2. ADD MULTIPLE SCRAP ITEMS (Manager Step 2)
   ========================================================== */
router.post("/:id/items", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Items array required" });
    }

    await client.query("BEGIN");

    // Insert each item
    for (const it of items) {
      await client.query(
        `INSERT INTO maal_in_items
         (maal_in_id, material, weight, rate, amount)
         VALUES ($1,$2,$3,$4,$5);`,
        [id, it.material, it.weight, it.rate, it.amount]
      );
    }

    // Recalculate total
    const total = await client.query(
      `SELECT SUM(amount) AS total FROM maal_in_items WHERE maal_in_id=$1`,
      [id]
    );

    await client.query(
      `UPDATE maal_in SET total_amount=$1 WHERE id=$2`,
      [total.rows[0].total || 0, id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Items added successfully & total updated"
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ MaalIn Items Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});


/* ==========================================================
   3. LIST MAAL IN (Owner View)
   ========================================================== */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({
        success: false,
        error: "company_id and godown_id required"
      });
    }

    const params = [company_id, godown_id];
    let where = `WHERE company_id=$1 AND godown_id=$2`;

    if (date) {
      params.push(date);
      where += ` AND date=$${params.length}`;
    }

    const q = `
      SELECT *
      FROM maal_in
      ${where}
      ORDER BY date DESC, created_at DESC;
    `;

    const result = await pool.query(q, params);

    return res.json({
      success: true,
      maal_in: result.rows
    });

  } catch (err) {
    console.error("❌ MaalIn List Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


/* ==========================================================
   4. GET SINGLE MAAL IN + ITEMS (Owner Detail Page)
   ========================================================== */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const header = await pool.query(
      `SELECT * FROM maal_in WHERE id=$1`,
      [id]
    );

    if (header.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Maal In not found" });
    }

    const items = await pool.query(
      `SELECT * FROM maal_in_items WHERE maal_in_id=$1 ORDER BY material`,
      [id]
    );

    return res.json({
      success: true,
      maal_in: header.rows[0],
      items: items.rows
    });

  } catch (err) {
    console.error("❌ MaalIn Detail Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


/* ==========================================================
   5. OWNER APPROVE / REJECT
   ========================================================== */
router.post("/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    const { action, approved_by } = req.body;

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ success: false, error: "Invalid action" });
    }

    const newStatus = action === "approve" ? "approved" : "rejected";

    const q = `
      UPDATE maal_in
      SET status=$1, approved_by=$2, 
          approved_at = CASE WHEN $1='approved' THEN NOW() ELSE NULL END
      WHERE id=$3
      RETURNING *;
    `;

    const result = await pool.query(q, [newStatus, approved_by, id]);

    return res.json({
      success: true,
      maal_in: result.rows[0]
    });

  } catch (err) {
    console.error("❌ Approve Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


export default router;
