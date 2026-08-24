const fs = require('fs');
const path = require('path');

function findSqlStatements(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === 'dist' || file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      findSqlStatements(filePath, fileList);
    } else if (filePath.endsWith('.js') || filePath.endsWith('.ts')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const backendDir = __dirname;
const allFiles = findSqlStatements(backendDir);
let allSql = [];

const createTableRegex = /CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)(?:;|\`)/gm;
const alterTableRegex = /ALTER TABLE\s+([a-zA-Z0-9_]+)\s+ADD COLUMN IF NOT EXISTS\s+(.*?)(?:;|\`)/g;

let schema = {};

for (const file of allFiles) {
  const content = fs.readFileSync(file, 'utf8');
  let match;
  
  // Find Create tables
  const createRegex = new RegExp(createTableRegex);
  while ((match = createRegex.exec(content)) !== null) {
    const tableName = match[1];
    let columns = match[2];
    
    // Stop at the first closing parenthesis that matches the table definition
    // This is a naive parse but will grab most of the table body.
    if (!schema[tableName]) {
      schema[tableName] = { columns: [], file: file };
    }
    
    const lines = columns.split(',\n').map(l => l.trim()).filter(l => l);
    for (const line of lines) {
       schema[tableName].columns.push(line);
    }
  }
  
  // Find Alter tables
  const alterRegex = new RegExp(alterTableRegex);
  while ((match = alterRegex.exec(content)) !== null) {
    const tableName = match[1];
    const columnDef = match[2].trim();
    if (schema[tableName]) {
      schema[tableName].columns.push(`[ALTER] ${columnDef}`);
    } else {
      schema[tableName] = { columns: [`[ALTER] ${columnDef}`], file: file };
    }
  }
}

fs.writeFileSync('schema_extract.json', JSON.stringify(schema, null, 2));
console.log('Done parsing schema.');
