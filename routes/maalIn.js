/* ==========================================================
   6. UNIFIED MAAL IN (FERIWALA / KABADIWALA / LOCAL / FACTORY)
   ========================================================== */
router.post("/unified", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      company_id,
      godown_id,
      vendor_type,   // feriwala | kabadiwala | local | factory
      vendor_id,     // required for feriwala & kabadiwala
      date,
      scraps,
      note = ""
    } = req.body;

    if (!company_id || !godown_id || !vendor_type || !date || !scraps?.length) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields"
      });
    }

    await client.query("BEGIN");

    /* =====================================
       1. GET SUPPLIER NAME
    ===================================== */
    let supplier_name = vendor_type.toUpperCase();

    if (vendor_type === "feriwala" || vendor_type === "kabadiwala") {
      const vRes = await client.query(
        `SELECT name FROM vendors WHERE id=$1`,
        [vendor_id]
      );
      supplier_name = vRes.rows[0]?.name;
    }

    /* =====================================
       2. CREATE MAAL_IN HEADER
    ===================================== */
    const maalRes = await client.query(
      `INSERT INTO maal_in
       (company_id, godown_id, date, supplier_name, source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manager')
       RETURNING id`,
      [
        company_id,
        godown_id,
        date,
        supplier_name,
        vendor_type,
        note
      ]
    );

    const maal_in_id = maalRes.rows[0].id;

    /* =====================================
       3. INSERT MAAL_IN ITEMS
    ===================================== */
    for (const s of scraps) {
      const matRes = await client.query(
        `SELECT material_type FROM scrap_types WHERE id=$1`,
        [s.scrap_type_id]
      );

      await client.query(
        `INSERT INTO maal_in_items
         (maal_in_id, material, weight)
         VALUES ($1,$2,$3)`,
        [maal_in_id, matRes.rows[0].material_type, s.weight]
      );
    }

    /* =====================================
       4. PERSONAL LEDGER ENTRY
    ===================================== */

    // FERIWALA
    if (vendor_type === "feriwala") {
      await client.query(
        `INSERT INTO feriwala_records
         (id, company_id, godown_id, vendor_id, date, created_at)
         VALUES (uuid_generate_v4(),$1,$2,$3,$4,NOW())`,
        [company_id, godown_id, vendor_id, date]
      );
    }

    // KABADIWALA (purchase only, payment later)
    if (vendor_type === "kabadiwala") {
      await client.query(
        `INSERT INTO kabadiwala_records
         (id, company_id, godown_id, vendor_id, kabadiwala_name,
          date, total_amount, payment_status, created_at)
         VALUES (uuid_generate_v4(),$1,$2,$3,$4,$5,0,'pending',NOW())`,
        [
          company_id,
          godown_id,
          vendor_id,
          supplier_name,
          date
        ]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      maal_in_id,
      message: "Unified Maal In saved successfully"
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Unified MaalIn Error:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  } finally {
    client.release();
  }
});
