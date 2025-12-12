// ✅ Truck Routes - Truck Driver & Vehicle Ledger
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/**
 * ✅ Add Truck Driver Record
 */
router.post("/add", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      date,
      driver_name,
      vehicle_number,
      trip_details,
      cost,
      fuel_cost,
      miscellaneous,
      amount_paid,
      return_amount,
    } = req.body;

    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO truck_transactions 
       (id, company_id, godown_id, date, driver_name, vehicle_number, trip_details, 
        cost, fuel_cost, miscellaneous, amount_paid, return_amount, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       RETURNING id;`,
      [
        company_id,
        godown_id,
        date,
        driver_name,
        vehicle_number,
        trip_details,
        cost,
        fuel_cost,
        miscellaneous,
        amount_paid,
        return_amount,
      ]
    );

    await client.query("COMMIT");
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Truck Add Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * ✅ Fetch all Truck Records
 */
router.get("/all", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;
    const result = await pool.query(
      `SELECT * FROM truck_transactions 
       WHERE company_id = $1 AND godown_id = $2 
       ORDER BY date DESC, created_at DESC;`,
      [company_id, godown_id]
    );

    res.json({ success: true, trucks: result.rows });
  } catch (err) {
    console.error("❌ Fetch Truck Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ Update Truck Record
 */
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      date,
      driver_name,
      vehicle_number,
      trip_details,
      cost,
      fuel_cost,
      miscellaneous,
      amount_paid,
      return_amount,
    } = req.body;

    const result = await pool.query(
      `UPDATE truck_transactions
       SET date = $1, driver_name = $2, vehicle_number = $3, trip_details = $4,
           cost = $5, fuel_cost = $6, miscellaneous = $7,
           amount_paid = $8, return_amount = $9
       WHERE id = $10
       RETURNING *;`,
      [
        date,
        driver_name,
        vehicle_number,
        trip_details,
        cost,
        fuel_cost,
        miscellaneous,
        amount_paid,
        return_amount,
        id,
      ]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Record not found" });

    res.json({ success: true, updated: result.rows[0] });
  } catch (err) {
    console.error("❌ Update Truck Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ Delete Truck Record
 */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM truck_transactions WHERE id = $1;`,
      [id]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Record not found" });

    res.json({ success: true, message: "Truck record deleted successfully" });
  } catch (err) {
    console.error("❌ Delete Truck Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
