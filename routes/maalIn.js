// backend/routes/maalIn.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* ==========================================================
   1. CREATE MAAL IN HEADER (Manager – Step 1)
   ========================================================== */
router.post("/", async (req, res) => {
  try {
    const {
      company_id,
      godown_id,
      date,
      supplier_name,
      source = "kabadiwala",
      vehicle_number = null,
      notes = null,
      created_by = "manager",
    } = req.body;

    if (!company_id || !godown_id || !supplier_name || !date) {
      return res.status(400).json({
        success: false,
        error: "company_id, godown_id, supplier_name and date are required",
      });
    }

    const q = `
      INSERT INTO maal_in
      (company_id, godown_id, date, supplier_name, source, vehicle_number, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *;
    `;

    const { rows } = await pool.query(q, [
      company_id,
      godown_id,
      date,
      supplier_name,
      source,
      vehicle_number,
      notes,
      created_by,
    ]);

    return res.status(201).json({
      success: true,
      maal_in: rows[0],
    });
  } catch (err) {
    console.error("❌ MaalIn Header Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================
   2. ADD MULTIPLE SCRAP ITEMS (Manager – Step 2)
   ========================================================== */
router.post("/:id/items", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Items array required" });
    }

    await client.query("BEGIN");

    for (const it of items) {
      await client.query(
        `
        INSERT INTO maal_in_items
        (maal_in_id, material, weight, rate, amount)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [id, it.material, it.weight, it.rate, it.amount]
      );
    }

    const totalRes = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM maal_in_items WHERE maal_in_id=$1`,
      [id]
    );

    await client.query(
      `UPDATE maal_in SET total_amount=$1 WHERE id=$2`,
      [totalRes.rows[0].total, id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Items added and total updated",
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
   3. LIST MAAL IN (Owner / Dashboard)
   ========================================================== */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({
        success: false,
        error: "company_id and godown_id required",
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
      ORDER BY date DESC, created_at DESC
    `;

    const { rows } = await pool.query(q, params);

    return res.json({
      success: true,
      maal_in: rows,
    });
  } catch (err) {
    console.error("❌ MaalIn List Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================
   4. GET SINGLE MAAL IN + ITEMS
   ========================================================== */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const headerRes = await pool.query(
      `SELECT * FROM maal_in WHERE id=$1`,
      [id]
    );

    if (headerRes.rowCount === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Maal In not found" });
    }

    const itemsRes = await pool.query(
      `SELECT * FROM maal_in_items
       WHERE maal_in_id=$1
       ORDER BY material`,
      [id]
    );

    return res.json({
      success: true,
      maal_in: headerRes.rows[0],
      items: itemsRes.rows,
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
      return res
        .status(400)
        .json({ success: false, error: "Invalid action" });
    }

    const status = action === "approve" ? "approved" : "rejected";

    const q = `
      UPDATE maal_in
      SET status=$1,
          approved_by=$2,
          approved_at = CASE WHEN $1='approved' THEN NOW() ELSE NULL END
      WHERE id=$3
      RETURNING *
    `;

    const { rows } = await pool.query(q, [status, approved_by, id]);

    return res.json({
      success: true,
      maal_in: rows[0],
    });
  } catch (err) {
    console.error("❌ MaalIn Approve Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
