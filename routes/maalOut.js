// routes/maalOut.js
import express from "express";
import { pool } from "../config/db.js";
import { randomUUID } from "crypto";

const router = express.Router();

/* ===============================================================
   1) ADD SALE
================================================================*/
router.post("/add-sale", async (req, res) => {
  try {
    const {
      company_id,
      godown_id,
      firm_name,
      bill_to,
      ship_to,
      date,
      weight,
      bill_rate,
      original_rate,
      gst_percent,
      freight,
      vehicle_no,
      freight_payment_status,
    } = req.body;

    const bill_amount = Number(weight) * Number(bill_rate);
    const original_amount = Number(weight) * Number(original_rate);
    const gst_amount = (bill_amount * Number(gst_percent)) / 100;

    const q = `
      INSERT INTO maal_out
      (id, company_id, godown_id, firm_name, bill_to, ship_to, date,
        weight, bill_rate, bill_amount, original_rate, original_amount,
        gst_percent, gst_amount, freight, freight_payment_status,
        vehicle_no, created_at)
      VALUES 
      (uuid_generate_v4(), $1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      RETURNING *;
    `;

    const result = await pool.query(q, [
      company_id,
      godown_id,
      firm_name,
      bill_to,
      ship_to,
      date,
      weight,
      bill_rate,
      bill_amount,
      original_rate,
      original_amount,
      gst_percent,
      gst_amount,
      freight,
      freight_payment_status,
      vehicle_no,
    ]);

    res.json({ success: true, sale: result.rows[0] });
  } catch (err) {
    console.error("ADD SALE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ===============================================================
   2) UPDATE SALE
================================================================*/
router.put("/update-sale/:id", async (req, res) => {
  try {
    const saleId = req.params.id;

    const {
      firm_name,
      bill_to,
      ship_to,
      date,
      weight,
      bill_rate,
      original_rate,
      gst_percent,
      freight,
      vehicle_no,
      freight_payment_status,
    } = req.body;

    const bill_amount = Number(weight) * Number(bill_rate);
    const original_amount = Number(weight) * Number(original_rate);
    const gst_amount = (bill_amount * Number(gst_percent)) / 100;

    const q = `
      UPDATE maal_out
      SET firm_name=$1, bill_to=$2, ship_to=$3, date=$4::date,
          weight=$5, bill_rate=$6, bill_amount=$7,
          original_rate=$8, original_amount=$9,
          gst_percent=$10, gst_amount=$11,
          freight=$12, freight_payment_status=$13,
          vehicle_no=$14
      WHERE id=$15
      RETURNING *;
    `;

    const result = await pool.query(q, [
      firm_name,
      bill_to,
      ship_to,
      date,
      weight,
      bill_rate,
      bill_amount,
      original_rate,
      original_amount,
      gst_percent,
      gst_amount,
      freight,
      freight_payment_status,
      vehicle_no,
      saleId,
    ]);

    res.json({ success: true, sale: result.rows[0] });
  } catch (err) {
    console.error("UPDATE SALE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ===============================================================
   3) DELETE SALE
================================================================*/
router.delete("/delete-sale/:id", async (req, res) => {
  try {
    const saleId = req.params.id;

    const result = await pool.query(
      `DELETE FROM maal_out WHERE id=$1 RETURNING id`,
      [saleId]
    );

    if (!result.rowCount)
      return res
        .status(404)
        .json({ success: false, error: "Sale not found" });

    res.json({ success: true, message: "Sale deleted" });
  } catch (err) {
    console.error("DELETE SALE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ===============================================================
   4) LIST SALES (month OR date)
================================================================*/
router.get("/list-sales", async (req, res) => {
  try {
    const { company_id, godown_id, date, month } = req.query;

    if (!company_id || !godown_id)
      return res.status(400).json({
        success: false,
        error: "company_id and godown_id required",
      });

    const params = [company_id, godown_id];
    let where = `company_id=$1 AND godown_id=$2`;

    if (month) {
      params.push(month);
      where += ` AND TO_CHAR(date, 'YYYY-MM') = $${params.length}`;
    } else if (date) {
      params.push(date);
      where += ` AND date = $${params.length}::date`;
    }

    const q = `
      SELECT *,
      (COALESCE(original_amount,0)+COALESCE(gst_amount,0)) AS total_invoice_amount
      FROM maal_out
      WHERE ${where}
      ORDER BY date DESC, created_at DESC;
    `;

    const rows = await pool.query(q, params);

    res.json({ success: true, sales: rows.rows });
  } catch (err) {
    console.error("LIST SALES ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ===============================================================
   5) ADD PAYMENT
================================================================*/
// ADD PAYMENT (Mill → Rokadi BANK CREDIT)
router.post("/add-payment", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      firm_name,
      amount,
      date,
      company_id,
      godown_id,
    } = req.body;

    if (!firm_name || !amount || !company_id || !godown_id) {
      return res.json({ success: false, error: "Missing fields" });
    }

    await client.query("BEGIN");

    /* ===========================
       1️⃣ Save Mill Payment
    ============================ */
    const paymentResult = await client.query(
      `
      insert into maal_out_payments
        (firm_name, amount, date, company_id, godown_id)
      values ($1, $2, $3, $4, $5)
      returning id
      `,
      [firm_name, amount, date, company_id, godown_id]
    );

    const paymentId = paymentResult.rows[0].id;

    /* ===========================
       2️⃣ Get BANK Rokadi Account
    ============================ */
    const bankAccountRes = await client.query(
      `select get_bank_rokadi_account($1,$2) as account_id`,
      [company_id, godown_id]
    );

    const rokadiAccountId = bankAccountRes.rows[0].account_id;

    // Lock the rokadi account row so balance checks are stable and to avoid
    // double-applying changes if a DB trigger already updates balances.
    const beforeBalRes = await client.query(
      `select balance::numeric as balance from rokadi_accounts where id=$1 for update`,
      [rokadiAccountId]
    );
    const beforeBalance = Number(beforeBalRes.rows[0]?.balance ?? 0);

    /* ===========================
       3️⃣ Insert Rokadi CREDIT
    ============================ */
    const displayRef = `Mill payment: ${firm_name}`;
    const internalRef = `maal_out_payment:${paymentId}`;
    const metadata = {
      source: "maal_out",
      maal_out_payment_id: paymentId,
      note: displayRef,
    };
    await client.query(
      `
      insert into rokadi_transactions
        (id, account_id, company_id, godown_id, type, amount, reference, metadata, category)
      values
        ($1, $2, $3, $4, 'credit', $5, $6, $7::jsonb, 'mill_payment')
      `,
      [
        randomUUID(),
        rokadiAccountId,
        company_id,
        godown_id,
        amount,
        internalRef,
        JSON.stringify(metadata),
      ]
    );

    /* ===========================
       4️⃣ Update Rokadi Balance
    ============================ */
    const afterBalRes = await client.query(
      `select balance::numeric as balance from rokadi_accounts where id=$1`,
      [rokadiAccountId]
    );
    const afterBalance = Number(afterBalRes.rows[0]?.balance ?? 0);

    // If balance didn't change after inserting the transaction, apply the manual update.
    // If balance already changed (e.g., trigger-based), skip to avoid double credit.
    if (afterBalance === beforeBalance) {
      await client.query(
        `
        update rokadi_accounts
        set balance = balance + $1
        where id = $2
        `,
        [amount, rokadiAccountId]
      );
    }

    await client.query("COMMIT");

    res.json({ success: true, payment_id: paymentId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});
/* ===============================================================
   6) UPDATE PAYMENT
================================================================*/
router.put("/update-payment/:id", async (req, res) => {
  try {
    const paymentId = req.params.id;
    const { firm_name, amount, date } = req.body;

    const q = `
      UPDATE maal_out_payments
      SET firm_name=$1, amount=$2, date=$3::date
      WHERE id=$4
      RETURNING *;
    `;

    const result = await pool.query(q, [
      firm_name,
      amount,
      date,
      paymentId,
    ]);

    res.json({ success: true, payment: result.rows[0] });
  } catch (err) {
    console.error("UPDATE PAYMENT ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ===============================================================
   7) DELETE PAYMENT
================================================================*/
router.delete("/delete-payment/:id", async (req, res) => {
  try {
    const paymentId = req.params.id;

    const q = `DELETE FROM maal_out_payments WHERE id=$1 RETURNING id`;
    const r = await pool.query(q, [paymentId]);

    if (!r.rowCount)
      return res
        .status(404)
        .json({ success: false, error: "Payment not found" });

    res.json({ success: true, message: "Payment deleted" });
  } catch (err) {
    console.error("DELETE PAYMENT ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ===============================================================
   8) LIST PAYMENTS (month OR date)
================================================================*/
router.get("/list-payments", async (req, res) => {
  try {
    const { company_id, godown_id, date, month } = req.query;

    const params = [company_id, godown_id];
    let where = `company_id=$1 AND godown_id=$2`;

    if (month) {
      params.push(month);
      where += ` AND TO_CHAR(date, 'YYYY-MM') = $${params.length}`;
    } else if (date) {
      params.push(date);
      where += ` AND date = $${params.length}::date`;
    }

    const q = `
      SELECT *
      FROM maal_out_payments
      WHERE ${where}
      ORDER BY date DESC, created_at DESC;
    `;

    const rows = await pool.query(q, params);
    res.json({ success: true, payments: rows.rows });
  } catch (err) {
    console.error("LIST PAYMENTS ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
