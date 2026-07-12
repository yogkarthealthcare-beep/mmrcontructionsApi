import sql from "../db.js";

const translations = [
  { id: 1, name: "पैन कार्ड", type: "कर दस्तावेज़", description: "कंपनी का आधिकारिक स्थायी खाता संख्या (पैन) दस्तावेज़।" },
  { id: 2, name: "अंतर्नियमावली", type: "कंपनी दस्तावेज़", description: "कंपनी के आंतरिक प्रबंधन और संचालन से संबंधित आधिकारिक अंतर्नियमावली।" },
  { id: 3, name: "संस्था के बहिर्नियम", type: "कंपनी दस्तावेज़", description: "कंपनी के उद्देश्य और कार्यक्षेत्र को निर्धारित करने वाला आधिकारिक बहिर्नियम दस्तावेज़।" },
  { id: 4, name: "निगमन प्रमाणपत्र", type: "कंपनी दस्तावेज़", description: "कंपनी के विधिवत निगमन की पुष्टि करने वाला आधिकारिक प्रमाणपत्र।" },
];

try {
  for (const document of translations) {
    await sql`
      UPDATE company_documents
      SET document_name_hi = ${document.name},
          document_type_hi = ${document.type},
          document_description_hi = ${document.description},
          updated_at = NOW()
      WHERE id = ${document.id}`;
  }
  console.log(`Updated ${translations.length} company document Hindi translations.`);
} finally {
  await sql.end();
}
