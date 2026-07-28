import sql from "../db.js";
async function check() {
  const enums = await sql`SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'actor_type_enum')`;
  console.log("actor_type_enum values:", enums);
  process.exit(0);
}
check();
