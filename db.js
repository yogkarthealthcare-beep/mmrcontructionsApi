import postgres from "postgres";
import dotenv from "dotenv";

dotenv.config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: "require",
  onnotice: () => {},
});

export default sql;
