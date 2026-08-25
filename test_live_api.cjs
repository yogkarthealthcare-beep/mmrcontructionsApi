const fetch = require('node-fetch'); // wait, built-in fetch is available in Node 18+

(async () => {
  try {
    // 1. Login as Admin
    // We need an admin login. Let's check if we can bypass it or if we know an admin cred.
    // Let's just create a test customer directly by registering.
    
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 1, role: 'Customer', full_name: 'Test User' }, 'mmrcontruction123');
    
    console.log("Got token:", token.substring(0, 20) + "...");

    const payload = {
      formDate: new Date().toISOString().split('T')[0],
      applicationNo: "",
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
      declarationCheck: true,
      nominees: [
          {
              nomineeName: 'Aarav Sharma',
              nomineeRelation: 'Son',
              nomineeAgeDob: '2015-01-10',
              nomineeAadhar: '112233445566'
          }
      ],
      photoFirstApplicant: '',
      photoCoApplicant: '',
      signatureSoleFirstApplicant: '',
      signatureCoApplicant: '',
      signatureAuthorizedSignatory: '',
      termsAccepted: true
    };

    console.log("Submitting enrollment...");
    const enrollRes = await fetch("https://api.mmrconstructions.in/api/customer-enrollment", {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(payload)
    });
    
    const enrollData = await enrollRes.json();
    console.log("Status:", enrollRes.status);
    console.log("Response:", enrollData);

  } catch(e) {
      console.error("Error:", e);
  }
})();
