import { pool } from "../db/pool.js";

// ADD MAAL IN
export const addMaalIn = async (req, res) => {
  try {
    const {
      company_id,
      godown_id,
      date,
      feriwala_name,
      scrap_details,
      total_weight,
      total_price,
      payment_mode,
      amount_paid,
      balance,
      notes,
      created_by,
    } = req.body;

    const query = `
      INSERT INTO maal_in
      (company_id, godown_id, date, feriwala_name, scrap_details,
       total_weight, total_price, payment_mode, amount_paid, balance,
       notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *;
    `;

    const values = [
      company_id,
      godown_id,
      date,
      feriwala_name,
      scrap_details,
      total_weight,
      total_price,
      payment_mode,
      amount_paid,
      balance,
      notes,
      created_by,
    ];

    const { rows } = await pool.query(query, values);
    res.json({ success: true, maal: rows[0] });
  } catch (err) {
    console.error("ADD MAAL ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// LIST MAAL IN BY DATE
export const listMaalIn = async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    const { rows } = await pool.query(
      `SELECT * FROM maal_in
       WHERE company_id=$1 AND godown_id=$2 AND date=$3
       ORDER BY created_at DESC`,
      [company_id, godown_id, date]
    );

    res.json({ success: true, maal_in: rows });
  } catch (err) {
    console.error("LIST MAAL ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// SUMMARY
export const maalSummary = async (req, res) => {
  try {
    const { company_id, godown_id, start_date, end_date } = req.query;

    const { rows } = await pool.query(
      `SELECT
         SUM(total_weight) AS total_weight,
         SUM(total_price) AS total_price,
         SUM(amount_paid) AS total_paid,
         SUM(balance) AS total_balance
       FROM maal_in
       WHERE company_id=$1 AND godown_id=$2
         AND date BETWEEN $3 AND $4`,
      [company_id, godown_id, start_date, end_date]
    );

    res.json({ success: true, summary: rows[0] });
  } catch (err) {
    console.error("SUMMARY ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
