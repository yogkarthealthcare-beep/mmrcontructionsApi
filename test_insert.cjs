const sql = require('./db.js').default; // assuming ESM or similar, wait db.js is ESM?
// Let's use dynamic import since backend is ESM
(async () => {
  const { default: sql } = await import('./db.js');
  
  try {
    const b = {
      formDate: new Date().toISOString().split('T')[0],
      projectName: 'MMR Green City',
      propertyType: 'Residential Plot',
      plotFlatNo: 'A-101',
      blockTower: 'Block A',
      sizeArea: '1000 Sq. Ft.',
      rate: '1500',
      bsp: 1500000,
      plcDev: 50000,
      
      applicantName: 'Rahul Sharma',
      fhName: 'Ramesh Sharma',
      dob: '1990-05-15',
      age: 34,
      gender: 'M',
      maritalStatus: 'Married',
      nationality: 'Indian',
      pan: 'ABCDE1234F',
      aadhar: '123456789012',
      occupation: 'Software Engineer',
      presentAddress: '123 Tech Park',
      presentCity: 'Noida',
      presentStatePin: 'UP 201301',
      permanentAddress: '123 Tech Park',
      permanentCity: 'Noida',
      permanentStatePin: 'UP 201301',
      mobile1: '9876543210',
      mobile2: '9876543211',
      email1: 'rahul.sharma@example.com',

      coApplicantName: 'Priya Sharma',
      coFhName: 'Rahul Sharma',
      coRelation: 'Wife',
      coDob: '1992-08-20',
      coAge: 32,
      coGender: 'F',
      coPan: 'FGHIJ5678K',
      coAadhar: '987654321098',
      coPresentAddress: '123 Tech Park',
      coMobile: '9876543212',
      coEmail: 'priya.sharma@example.com',
      
      bookingAmount: 100000,
      bookingAmountWords: 'One Lakh Only',
      paymentMode: 'UPI',
      txnNo: 'UPI123456789',
      txnDate: new Date().toISOString().split('T')[0],
      drawnBankBranch: 'HDFC Bank, Sector 18',
      
      accHolderName: 'Rahul Sharma',
      accBankBranch: 'HDFC Noida Sector 18',
      accNumber: '50100234567890',
      ifscCode: 'HDFC0000123',

      associateName: 'Amit Agent',
      associateId: 'MMR-AGT-001',
      associateMobile: '9988776655',
      associateSignatureName: 'Amit Agent',
      
      declarationCheck: true
    };

    const user_id = 1; // Dummy
    const appNo = 'MMR-CEF-TEST-999';
    const bsp = Number(b.bsp) || 0;
    const plc = Number(b.plcDev) || 0;
    const totalVal = bsp + plc;
    const photoFirstUrl = null;
    const photoCoUrl = null;
    const sigSoleUrl = null;
    const sigCoUrl = null;
    const sigAuthUrl = null;

    const [newRow] = await sql`
        INSERT INTO customer_enrollment_submissions (
          user_id, form_date, application_no, project_name, property_type, property_type_other, plot_flat_no, block_tower, size_area, rate_per_unit, basic_sale_price, plc_dev_charges, total_property_value,
          applicant_name, fh_name, date_of_birth, age, gender, marital_status, nationality, nationality_other, pan_no, aadhar_no, occupation,
          present_address, present_city, present_state_pin, permanent_address, permanent_city, permanent_state_pin, mobile_1, mobile_2, email_1, photo_first_applicant_url,
          co_applicant_name, co_fh_name, co_relation, co_date_of_birth, co_age, co_gender, co_pan_no, co_aadhar_no, co_present_address, co_mobile, co_email, photo_co_applicant_url,
          booking_amount, booking_amount_words, payment_mode, txn_cheque_no, txn_date, drawn_bank_branch,
          acc_holder_name, acc_bank_branch, acc_number, ifsc_code,
          associate_name, associate_id, associate_mobile, associate_signature_name,
          declaration_accepted, signature_sole_first_applicant_url, signature_co_applicant_url, signature_authorized_signatory_url, terms_accepted, terms_accepted_at
        ) VALUES (
          ${user_id}, ${b.formDate || null}, ${b.applicationNo || appNo}, ${b.projectName || null}, ${b.propertyType || null}, ${b.propertyTypeOther || null}, ${b.plotFlatNo || null}, ${b.blockTower || null}, ${b.sizeArea || null}, ${b.rate || null}, ${bsp}, ${plc}, ${totalVal},
          ${b.applicantName}, ${b.fhName || null}, ${b.dob || null}, ${b.age || null}, ${b.gender || null}, ${b.maritalStatus || null}, ${b.nationality || null}, ${b.nationalityOther || null}, ${b.pan || null}, ${b.aadhar || null}, ${b.occupation || null},
          ${b.presentAddress || null}, ${b.presentCity || null}, ${b.presentStatePin || null}, ${b.permanentAddress || null}, ${b.permanentCity || null}, ${b.permanentStatePin || null}, ${b.mobile1}, ${b.mobile2 || null}, ${b.email1 || null}, ${photoFirstUrl},
          ${b.coApplicantName || null}, ${b.coFhName || null}, ${b.coRelation || null}, ${b.coDob || null}, ${b.coAge || null}, ${b.coGender || null}, ${b.coPan || null}, ${b.coAadhar || null}, ${b.coPresentAddress || null}, ${b.coMobile || null}, ${b.coEmail || null}, ${photoCoUrl},
          ${b.bookingAmount || null}, ${b.bookingAmountWords || null}, ${b.paymentMode || null}, ${b.txnNo || null}, ${b.txnDate || null}, ${b.drawnBankBranch || null},
          ${b.accHolderName || null}, ${b.accBankBranch || null}, ${b.accNumber || null}, ${b.ifscCode || null},
          ${b.associateName || null}, ${b.associateId || null}, ${b.associateMobile || null}, ${b.associateSignatureName || null},
          ${b.declarationAccepted || false}, ${sigSoleUrl}, ${sigCoUrl}, ${sigAuthUrl}, ${true}, NOW()
        ) RETURNING id
      `;

      console.log("Success! ID:", newRow.id);

      // cleanup
      await sql`DELETE FROM customer_enrollment_submissions WHERE id = ${newRow.id}`;
      process.exit(0);

  } catch(e) {
      console.error("SQL Error:", e.message);
      process.exit(1);
  }
})();
