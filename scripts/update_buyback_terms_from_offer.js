import sql from "../db.js";

const title = "बायबैक ऑफर एवं नियम व शर्तें";
const summary = "M.M.R. Constructions and Developers Pvt. Ltd. के प्लॉट बायबैक ऑफर, बुकिंग, रजिस्ट्री और भुगतान से संबंधित नियम ध्यानपूर्वक पढ़ें।";
const content = `बायबैक ऑफर की शर्तें

1. यदि ग्राहक 100 गज के प्लॉट की रजिस्ट्री 2 वर्ष के अंदर करवा लेता है और बाद में अपना प्लॉट पुनः कंपनी को बेचना चाहता है, तो कंपनी ग्राहक को उसके मूलधन के साथ ₹1,00,000 अतिरिक्त देगी।

2. यदि किसी प्लॉट उपभोक्ता (ग्राहक) के साथ ऐसी दुर्घटना हो जाती है, जिसके कारण वह किस्तें देने में असमर्थ हो जाए अथवा दुर्घटना में उसका निधन हो जाए, और ग्राहक ने कम से कम 18 महीने तक किस्तें जमा की हों, तो शेष किस्तें कंपनी माफ कर देगी। इसके बाद ग्राहक के नामित व्यक्ति/कानूनी वारिस को रजिस्ट्री, दाखिल-खारिज और कब्जा प्रदान किया जाएगा।

3. यदि कोई ग्राहक एकमुश्त भुगतान करके तुरंत रजिस्ट्री करवाता है, तो उसकी रजिस्ट्री का खर्च कंपनी वहन करेगी।

4. फाइनेंस सुविधा के लिए ₹499 फाइल चार्ज देय होगा।

नियम एवं शर्तें

1. प्लॉट की बुकिंग केवल कंपनी के अधिकृत कार्यालय में ही की जाएगी।

2. प्लॉट बुक करने के बाद बुकिंग राशि केवल उस स्थिति में वापस की जाएगी, जब ग्राहक किसी आकस्मिक दुर्घटना के कारण स्थायी रूप से दिव्यांग/विकलांग हो जाए। अन्य किसी स्थिति में बुकिंग राशि वापस नहीं होगी; ग्राहक को बुक किया गया प्लॉट ही प्रदान किया जाएगा।

3. 100 गज का प्लॉट बुक करने के लिए ₹1,00,000 डाउन पेमेंट (DP) देय होगा।

4. 50 गज का प्लॉट बुक करने के लिए ₹51,000 डाउन पेमेंट (DP) देय होगा।

5. किस्त का भुगतान विलंब से होने पर लागू विलंब शुल्क देय होगा।

6. पात्रता और संबंधित बैंक की स्वीकृति के अधीन बैंक फाइनेंस सुविधा उपलब्ध है।

महत्वपूर्ण सूचना: सभी लाभ और दावे ग्राहक के भुगतान रिकॉर्ड, बुकिंग दस्तावेज, पहचान, नामांकन तथा कंपनी के अभिलेखों के सत्यापन के अधीन होंगे। हस्ताक्षरित बुकिंग/विक्रय अनुबंध की शर्तें अंतिम और प्रभावी मानी जाएंगी।`;

async function run() {
  await sql`
    CREATE TABLE IF NOT EXISTS buyback_terms (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      content TEXT NOT NULL,
      updated_by_admin_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  const [existing] = await sql`SELECT id FROM buyback_terms ORDER BY id LIMIT 1`;
  if (existing) {
    await sql`
      UPDATE buyback_terms
      SET title = ${title}, summary = ${summary}, content = ${content}, updated_at = NOW()
      WHERE id = ${existing.id}`;
  } else {
    await sql`
      INSERT INTO buyback_terms (title, summary, content)
      VALUES (${title}, ${summary}, ${content})`;
  }
  console.log("Buyback offer and terms updated.");
  await sql.end();
}

run().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exitCode = 1;
});
