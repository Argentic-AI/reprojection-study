/** recall() must be deterministic, bounded, and actually find things. */
import { connect } from './db.ts';
import { journal_docs, index, search, render, tokens } from './recall.ts';

let failures = 0;
const check = (name: string, ok: boolean, note = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
};

check('identifier split', tokens('parse_config').join(',') === 'parse_config,parse,config');
check('no stopword list drops content', tokens('the parser').includes('the'));

const sql = connect();
const RUN = 'B1_mtj93me8';
const docs = await journal_docs(sql, RUN);
console.log(`journal: ${docs.length} documents for ${RUN}`);
check('journal is non-empty', docs.length > 0);

const ix = index(docs);
const q = 'config parser tokenize';
const a = search(ix, q);
const b = search(ix, q);
check('deterministic', JSON.stringify(a) === JSON.stringify(b));
check('finds something', a.length > 0, `${a.length} hits`);
check('bounded to 5', a.length <= 5);

const text = render(a);
check('output is bounded', text.length < 1200, `${text.length} chars`);
check('empty query is handled', render(search(ix, 'zzzznotathing')).startsWith('recall: nothing'));

console.log('\n--- what the agent would see ---');
console.log(text.split('\n').slice(0, 4).join('\n'));

await sql.end();
console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
