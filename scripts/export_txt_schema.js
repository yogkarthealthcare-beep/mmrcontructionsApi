import fs from "fs";
import path from "path";

const dumpPath = path.join(process.cwd(), "db_schema_dump.json");
const jsonContent = JSON.parse(fs.readFileSync(dumpPath, "utf-8"));

let txtOutput = "";
txtOutput += "================================================================================\n";
txtOutput += "                     MMR CONSTRUCTIONS DATABASE SCHEMA DUMP                      \n";
txtOutput += "================================================================================\n";
txtOutput += `Generated Date: ${new Date().toISOString()}\n`;
txtOutput += `Database Engine: PostgreSQL\n`;
txtOutput += `Total Tables: ${jsonContent.total_tables}\n`;
txtOutput += `Total Views: ${jsonContent.total_views}\n`;
txtOutput += "================================================================================\n\n";

txtOutput += "--------------------------------------------------------------------------------\n";
txtOutput += " 1. LIST OF ALL VIEWS\n";
txtOutput += "--------------------------------------------------------------------------------\n";
jsonContent.views.forEach((v, index) => {
  txtOutput += ` ${index + 1}. ${v}\n`;
});
txtOutput += "\n";

txtOutput += "--------------------------------------------------------------------------------\n";
txtOutput += " 2. ALL BASE TABLES WITH COLUMNS & DATA TYPES\n";
txtOutput += "--------------------------------------------------------------------------------\n\n";

jsonContent.tables.forEach((t, i) => {
  txtOutput += `[TABLE ${i + 1}] : ${t.table}\n`;
  txtOutput += `Row Count : ${t.rowCount}\n`;
  txtOutput += `Columns (${t.columns.length}) :\n`;
  txtOutput += `  ${"Column Name".padEnd(32)} | ${"Data Type".padEnd(20)} | ${"Nullable".padEnd(10)} | ${"Default Value"}\n`;
  txtOutput += `  ${"-".repeat(32)}-+-${"-".repeat(20)}-+-${"-".repeat(10)}-+-${"-".repeat(25)}\n`;
  
  t.columns.forEach(c => {
    const defaultStr = c.default !== null && c.default !== undefined ? String(c.default) : "NULL";
    txtOutput += `  ${c.name.padEnd(32)} | ${c.type.padEnd(20)} | ${c.nullable.padEnd(10)} | ${defaultStr}\n`;
  });
  txtOutput += "\n" + "=".repeat(80) + "\n\n";
});

const targetFile1 = "d:\\ClientsData\\MMRConstructions\\mmrconstructions-main\\database_tables_schema.txt";
const targetFile2 = "d:\\ClientsData\\MMRConstructions\\mmrconstructions-main\\mmrconstructionsApi\\database_tables_schema.txt";

fs.writeFileSync(targetFile1, txtOutput, "utf-8");
fs.writeFileSync(targetFile2, txtOutput, "utf-8");

console.log(`Saved text file schema to:\n 1. ${targetFile1}\n 2. ${targetFile2}`);
