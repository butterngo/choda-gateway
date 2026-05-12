import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'node:fs';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync('audit-entry.schema.json', 'utf8'));
const validate = ajv.compile(schema);

const lines = fs.readFileSync('audit-entry.example.jsonl', 'utf8').split(/\r?\n/).filter(Boolean);
let allOk = true;
lines.forEach((line, i) => {
  const obj = JSON.parse(line);
  if (!validate(obj)) {
    allOk = false;
    console.error(`Line ${i + 1} INVALID:`, validate.errors);
  } else {
    console.log(`Line ${i + 1} valid (event=${obj.event})`);
  }
});
process.exit(allOk ? 0 : 1);
