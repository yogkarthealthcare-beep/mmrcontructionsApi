const { sql } = require("./db");
const bcrypt = require("bcryptjs");

async function checkPass() {
    try {
        console.log("Checking recent password resets in otp_log...");
        const logs = await sql`SELECT * FROM otp_log WHERE purpose = 'ResetPassword' ORDER BY otp_id DESC LIMIT 5`;
        console.log("Recent OTPs:", logs);

        if (logs.length > 0) {
            const lastLog = logs[0];
            console.log("Checking user ID:", lastLog.reference_id);

            const users = await sql`SELECT user_id, email, mobile_no, password_hash FROM users WHERE user_id = ${lastLog.reference_id}`;
            if (users.length > 0) {
                console.log("User:", users[0]);
                console.log("Password hash length:", users[0].password_hash ? users[0].password_hash.length : 0);
            }
        }

        console.log("Checking investor_users password reset logs...");
        const investors = await sql`SELECT id, email, password_hash, updated_at FROM investor_users ORDER BY updated_at DESC LIMIT 2`;
        console.log("Recent Investors:", investors);
        
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
checkPass();
