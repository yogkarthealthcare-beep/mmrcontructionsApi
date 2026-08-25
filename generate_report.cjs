const fs = require('fs');

const schema = JSON.parse(fs.readFileSync('schema_extract.json', 'utf8'));
const usage = JSON.parse(fs.readFileSync('usage_extract.json', 'utf8'));

let md = `# MMR Constructions – Complete Database Table & Page Usage Audit\n\n`;

// 1. Executive Summary & Overview
const totalTables = Object.keys(usage).length;
let usedTables = 0;
let unusedTables = [];

for (const table in usage) {
  if (!usage[table].unused) usedTables++;
  else unusedTables.push(table);
}

md += `## 1. Executive Summary & Database Overview\n\n`;
md += `| Metric | Count |\n`;
md += `|--------|-------|\n`;
md += `| Total Tables | ${totalTables} |\n`;
md += `| Confirmed Used | ${usedTables} |\n`;
md += `| No Reference Found | ${unusedTables.length} |\n\n`;

md += `> [!NOTE]\n> Row counts are unavailable as the local database connection was refused. Table schemas were extracted directly from the backend node scripts and SQL statements.\n\n`;

// 4. Table Structure Details & 5. Usage
md += `## Table Structure Details & Usage (Parts 1, 2, & 4)\n\n`;

const tablesToScan = Object.keys(usage).sort();

for (const table of tablesToScan) {
  md += `### \`${table}\`\n`;

  if (schema[table]) {
    md += `**Columns:**\n\`\`\`sql\n`;
    md += schema[table].columns.join('\n');
    md += `\n\`\`\`\n`;
  } else {
    md += `*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).\n`;
  }

  md += `\n**Usage:**\n`;
  if (usage[table].unused) {
    md += `* **No application reference found.**\n`;
  } else {
    if (usage[table].backend.length > 0) {
      md += `* **Backend References:** Confirmed in ${usage[table].backend.length} files.\n`;
      const beFiles = usage[table].backend.slice(0, 5).map(f => f.split(/[\\/]/).pop());
      md += `  * *Examples:* ${beFiles.join(', ')}${usage[table].backend.length > 5 ? ', ...' : ''}\n`;
    }
    if (usage[table].frontend.length > 0) {
      md += `* **Frontend References:** Confirmed in ${usage[table].frontend.length} files.\n`;
      const feFiles = usage[table].frontend.slice(0, 5).map(f => f.split(/[\\/]/).pop());
      md += `  * *Examples:* ${feFiles.join(', ')}${usage[table].frontend.length > 5 ? ', ...' : ''}\n`;
    }
  }
  md += `\n---\n`;
}

// Column Duplication Analysis
md += `## Column Duplication Analysis (Part 5)\n\n`;
const columnMap = {};
for (const table in schema) {
  for (const colDef of schema[table].columns) {
    const colNameMatch = colDef.match(/^\s*([a-zA-Z0-9_]+)\s+/);
    if (colNameMatch) {
      const colName = colNameMatch[1];
      if (!columnMap[colName]) columnMap[colName] = [];
      columnMap[colName].push(table);
    }
  }
}

const importantCols = ['email', 'mobile', 'phone', 'user_id', 'investor_id', 'status', 'created_at', 'full_name', 'name'];
for (const col of importantCols) {
  if (columnMap[col]) {
    md += `**\`${col}\` is found in:**\n`;
    md += columnMap[col].map(t => `* \`${t}\``).join('\n') + `\n\n`;
  }
}

// Unused/Legacy Table Detection
md += `## Potentially Unused / Legacy Tables (Part 9)\n\n`;
if (unusedTables.length > 0) {
  for (const table of unusedTables) {
    md += `* **\`${table}\`** - No application reference found.\n`;
  }
} else {
  md += `All tables have at least one reference in the codebase.\n`;
}

fs.writeFileSync('MMR_Constructions_Database_and_Page_Usage_Audit.md', md);
console.log('Report generated in mmrconstructionsApi folder.');

